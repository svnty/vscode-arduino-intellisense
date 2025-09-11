import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import debounce from 'lodash.debounce';

interface BoardProperties {
  includePaths: string[];
  defines: string[];
  compilerPath: string;
}

// Cache to prevent unnecessary regeneration
const includeCache: { [file: string]: string } = {};
const includeActiveCache: { [file: string]: string } = {};
const boardCache: { [workspace: string]: string } = {};
const debouncedRegenerate: { [file: string]: () => void } = {};
const _docs: { [file: string]: string } = {};

// Cache for compilation results
interface CompilationCache {
  activeIncludes: string;
  fqbn: string;
  properties: BoardProperties;
}
const compilationCache: { [file: string]: CompilationCache } = {};

// Track regeneration state for each file
const isRegenerating: { [file: string]: boolean } = {};

export function activate(context: vscode.ExtensionContext) {
  const channel = vscode.window.createOutputChannel('Arduino IntelliSense');
  channel.show(true);

  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  workspaceFolders.forEach(folder => watchArduinoJson(folder.uri.fsPath));

  vscode.workspace.onDidSaveTextDocument(doc => {
    if (!doc.fileName.endsWith('.ino')) {
      return;
    }

    _docs[doc.fileName] = doc.getText();

    channel.appendLine(`Saved file ${doc.fileName}, checking if #includes have changed`);

    checkIncludesAndRegenerate(doc.fileName, channel);
  });

  vscode.workspace.onDidOpenTextDocument(doc => {
    if (!doc.fileName.endsWith('.ino')) {
      return;
    }
    _docs[doc.fileName] = doc.getText();

    channel.appendLine(`Opened file ${doc.fileName}, regenerating IntelliSense`);
    
    checkIncludesAndRegenerate(doc.fileName, channel);
  });

  // Watch for changes in Arduino sketches
  vscode.workspace.onDidChangeTextDocument(event => {
    const doc = event.document;
    if (!doc.fileName.endsWith('.ino')) {
      return;
    }
    _docs[doc.fileName] = doc.getText();

    if (!debouncedRegenerate[doc.fileName]) {
      debouncedRegenerate[doc.fileName] = debounce(() => {
        checkIncludesAndRegenerate(doc.fileName, channel);
      }, 2000); // Increased debounce time to 2 seconds
    }

    // Only check if changes might affect #include lines
    const includeLineChanged = event.contentChanges.some(change => {
      const startLine = change.range.start.line;
      const endLine = change.range.end.line;
      
      // Check if any changed lines contain or might contain #include
      for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
        const line = doc.lineAt(lineNum).text;
        if (line.includes('#include') || line.includes('include') || change.text.includes('#include')) {
          return true;
        }
      }
      return false;
    });

    if (includeLineChanged) {
      // Only run the expensive check if #include lines might have changed
      debouncedRegenerate[doc.fileName]();
    }
  });

  // Handle newly opened sketches (this is now handled by the first onDidOpenTextDocument handler above)
  // Removed duplicate handler to avoid conflicts

  async function watchArduinoJson(folderPath: string) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/arduino.json');

    watcher.onDidChange(debounce(async uri => {
      try {
        const content = await fs.readFile(uri.fsPath, 'utf8');
        const data = JSON.parse(content);
        const newBoard = data.board;

        if (newBoard && boardCache[folderPath] !== newBoard) {
          boardCache[folderPath] = newBoard;
          channel.appendLine(`Board changed to ${newBoard}, regenerating IntelliSense`);

          // Clear compilation cache for all sketches in this workspace
          Object.keys(compilationCache).forEach(sketchPath => {
            if (sketchPath.startsWith(folderPath)) {
              delete compilationCache[sketchPath];
            }
          });

          updateAllSketchesInWorkspace(folderPath);
        }
      } catch (err) {
        channel.appendLine(`Error reading arduino.json: ${err}`);
      }
    }, 1000));

    context.subscriptions.push(watcher);
  }

  function updateAllSketchesInWorkspace(folderPath: string) {
    vscode.workspace.textDocuments
      .filter(doc => doc.fileName.endsWith('.ino') && doc.fileName.startsWith(folderPath))
      .forEach(doc => regenerateIntellisense(doc.fileName, channel));
  }
}

// Efficient function to check includes and regenerate only if needed
function checkIncludesAndRegenerate(sketchPath: string, channel: vscode.OutputChannel) {
  const text = _docs[sketchPath];
  if (!text) {
    return;
  }

  // Fast check: count lines that start with #include (with optional whitespace)
  const includeRegex = /^\s*#include\s+[<"]([^>"]+)[>"]/;
  const lines = text.split(/\r?\n/);
  
  const activeIncludeStatements: string[] = [];
  
  // Only process lines that contain 'include' to avoid regex on every line
  for (const line of lines) {
    if (line.includes('include')) {
      const match = line.match(includeRegex);
      if (match) {
        activeIncludeStatements.push(match[1]);
      }
    }
  }

  // Update active includes cache with the current state
  const newActiveIncludes = activeIncludeStatements.join('\n');
  const oldActive = includeActiveCache[sketchPath] || '';

  if (newActiveIncludes !== oldActive) {
    includeActiveCache[sketchPath] = newActiveIncludes;
    channel.appendLine(`#include changed, regenerating IntelliSense for ${sketchPath}`);
    regenerateIntellisense(sketchPath, channel);
  }
}

async function regenerateIntellisense(sketchPath: string, channel: vscode.OutputChannel) {
  // Check if already running for this file
  if (isRegenerating[sketchPath]) {
    channel.appendLine(`Skipping regeneration - already running for ${sketchPath}`);
    return;
  }

  // Set the running flag
  isRegenerating[sketchPath] = true;

  const sketchDir = path.dirname(sketchPath);
  const vscodeDir = path.join(sketchDir, '.vscode');

  try {
    await fs.mkdir(vscodeDir, { recursive: true });

    // Find and read arduino.json
    const arduinoJsonPath = path.join(sketchDir, '.vscode', 'arduino.json');
    let FQBN = 'arduino:avr:uno'; // Default board

    try {
      const content = await fs.readFile(arduinoJsonPath, 'utf8');
      const data = JSON.parse(content);
      if (data.board) {
        FQBN = data.board;
      }
    } catch (err) {
      channel.appendLine(`Warning: Could not read arduino.json, using default board: ${err}`);
    }

    // Get active includes from cache or current document
    const activeIncludes = includeActiveCache[sketchPath] || '';
    channel.appendLine(`Active includes found: ${activeIncludes.split('\n').join(', ')}`);

    // Check if we can use cached compilation results
    const cache = compilationCache[sketchPath];
    let props: BoardProperties;

    if (cache && cache.activeIncludes === activeIncludes && cache.fqbn === FQBN) {
      channel.appendLine('Using cached compilation results - skipping compilation');
      props = cache.properties;
    } else {
      // Get board properties
      channel.appendLine(`Getting properties for board ${FQBN}...`);
      const newProps = await getBoardProperties(FQBN, sketchPath, channel, activeIncludes);

      if (!newProps) {
        channel.appendLine('Failed to get board properties');
        isRegenerating[sketchPath] = false;  // Make sure to clear the flag
        return;
      }

      props = newProps;

      // Cache the successful compilation results
      compilationCache[sketchPath] = {
        activeIncludes,
        fqbn: FQBN,
        properties: props
      };
    }

    // Generate c_cpp_properties.json
    const config = {
      configurations: [
        {
          name: FQBN,
          includePath: ['${workspaceFolder}/**', ...props.includePaths],
          defines: props.defines,
          compilerPath: props.compilerPath,
          cStandard: 'c11',
          cppStandard: 'c++17',
          intelliSenseMode: getIntelliSenseMode(props.compilerPath)
        }
      ],
      version: 4
    };

    const cCppPath = path.join(vscodeDir, 'c_cpp_properties.json');
    await fs.writeFile(cCppPath, JSON.stringify(config, null, 4));
    channel.appendLine(`✅ Generated IntelliSense configuration at ${cCppPath}`);

  } catch (err) {
    channel.appendLine(`Error generating IntelliSense configuration: ${err}`);
  } finally {
    // Clear the running flag
    isRegenerating[sketchPath] = false;
  }
}

async function getBoardProperties(FQBN: string, sketchPath: string, channel: vscode.OutputChannel, activeIncludes?: string): Promise<BoardProperties | null> {
  return new Promise(async (resolve) => {
    // Use a temporary sketch folder if we have active includes
    let tempSketchPath = sketchPath;
    let tempDir: string | undefined;

    if (activeIncludes) {
      const sketchContent = _docs[sketchPath] ? _docs[sketchPath] : await fs.readFile(sketchPath, 'utf8');
      const sketchName = path.basename(sketchPath, '.ino');
      const originalSketchDir = path.dirname(sketchPath);

      // Create a temporary sketch directory with the same name as the sketch
      tempDir = path.join(originalSketchDir, '.vscode', sketchName);
      await fs.mkdir(tempDir, { recursive: true });

      // Create the sketch file with the same name as the directory
      tempSketchPath = path.join(tempDir, `${sketchName}.ino`);
      await fs.writeFile(tempSketchPath, sketchContent);

      // Find only active (uncommented) local header files
      const activeIncludes = sketchContent.split(/\r?\n/)
        .filter(line => /^\s*#include\s*"([^"]+)"/.test(line))  // Only match uncommented includes
        .map(line => {
          const match = line.match(/^\s*#include\s*"([^"]+)"/);
          return match ? match[1] : null;
        })
        .filter((name): name is string => name !== null);

      // Copy only active local header files to the temp directory
      for (const headerFile of activeIncludes) {
        // Find all possible locations for the header
        channel.appendLine(`Searching for header: ${headerFile}`);

        try {
          // Use file_search to find the header file recursively
          const searchPattern = `**/${headerFile}`;
          const files = await vscode.workspace.findFiles(
            searchPattern,
            '**/node_modules/**' // Exclude node_modules
          );

          if (files.length > 0) {
            // Use the first matching file found
            const sourcePath = files[0].fsPath;

            // Preserve the include path structure
            const relativePath = headerFile.includes('/') ? headerFile : path.basename(headerFile);
            const targetPath = path.join(tempDir, relativePath);

            channel.appendLine(`Found header at: ${sourcePath}`);
            channel.appendLine(`Preserving path structure: ${relativePath}`);

            // Create subdirectories if needed
            await fs.mkdir(path.dirname(targetPath), { recursive: true });

            // Copy the header file
            await fs.copyFile(sourcePath, targetPath);
            channel.appendLine(`Copied local header to: ${targetPath}`);
          } else {
            // Try direct path as fallback
            const directPath = path.join(originalSketchDir, headerFile);
            try {
              await fs.access(directPath);

              // Preserve the include path structure for direct path too
              const relativePath = headerFile.includes('/') ? headerFile : path.basename(headerFile);
              const targetPath = path.join(tempDir, relativePath);

              channel.appendLine(`Using direct path, preserving structure: ${relativePath}`);

              // Create subdirectories if needed
              await fs.mkdir(path.dirname(targetPath), { recursive: true });

              // Copy the header file
              await fs.copyFile(directPath, targetPath);
              channel.appendLine(`✅ Copied local header (direct path) to: ${targetPath}`);
            } catch {
              channel.appendLine(`⚠️ Note: ${headerFile} not found in workspace, assuming it's a library include`);
            }
          }
        } catch (err) {
          channel.appendLine(`Error processing ${headerFile}: ${err}`);
        }
      }

      channel.appendLine(`Created temporary sketch at ${tempSketchPath}`);
    }

    channel.appendLine(`Compiling sketch ${tempSketchPath} for board ${FQBN}...`);

    // First get basic compilation info
    const args = ['compile', '--fqbn', FQBN, tempSketchPath, '--verbose'];
    const proc = spawn('arduino-cli', args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', data => stdout += data.toString());
    proc.stderr.on('data', data => stderr += data.toString());

    proc.on('close', async () => {
      // Clean up the entire temp directory
      try {
        if (tempDir) {
          channel.appendLine(`Cleaning up temp directory: ${tempDir}`);
          // First try to clean up the sketch directory
          await fs.rm(tempDir, { recursive: true, force: true });
        }
      } catch (err) {
        channel.appendLine(`Warning: Failed to clean up directories: ${err}`);
      }

      if (stderr) {
        channel.appendLine(`arduino-cli error: ${stderr}`);
      }

      const includePaths: string[] = [];
      const defines: string[] = [];
      let compilerPath = '';

      // Look for compiler lines from supported architectures:
      // - AVR: avr-g++ (Uno, Mega, etc.)
      // - ARM Cortex-M: arm-none-eabi-g++ (Uno R4, Zero, MKR, RP2040, etc.)
      // - ESP32: xtensa-esp32-elf-g++ (ESP32 series)
      // - ESP8266: xtensa-lx106-elf-g++ (ESP8266 series) 
      // - RISC-V: riscv32-esp-elf-g++ (ESP32-C3, CH32V, etc.)
      const gppLines = stdout.split(/\r?\n/).filter(l =>
        (l.includes('avr-g++') ||
          l.includes('arm-none-eabi-g++') ||
          l.includes('xtensa-esp32-elf-g++') ||
          l.includes('xtensa-lx106-elf-g++') ||
          l.includes('riscv32-esp-elf-g++')) &&
        l.includes('-I') // Only lines with include paths (compilation, not linking)
      );
      if (gppLines.length > 0) {
        const lastLine = gppLines[gppLines.length - 1];
        channel.appendLine(`Using compiler line: ${lastLine}`);
        const parts = lastLine.split(' ');

        let iprefix = '';

        parts.forEach(p => {
          if (p.startsWith('-I')) {
            includePaths.push(p.substring(2));
          }
          if (p.startsWith('-D')) {
            defines.push(p.substring(2));
          }
          if (p.startsWith('-iprefix')) {
            iprefix = p.substring(8); // Extract the iprefix path
          }
          if (p.startsWith('@') && p.includes('includes.txt')) {
            // Handle @includes.txt files
            const includesFile = p.substring(1);
            channel.appendLine(`Processing includes file: ${includesFile}`);
            try {
              const includesContent = require('fs').readFileSync(includesFile, 'utf8');
              const additionalIncludes = includesContent
                .split(/\s+/)
                .filter((line: string) => line.startsWith('-I') || line.startsWith('-iwithprefixbefore'))
                .map((line: string) => {
                  let includePath;
                  if (line.startsWith('-I')) {
                    includePath = line.substring(2);
                  } else if (line.startsWith('-iwithprefixbefore')) {
                    includePath = line.substring(19); // Remove '-iwithprefixbefore'
                  } else {
                    return '';
                  }

                  // If path is relative and we have an iprefix, combine them
                  if (!includePath.startsWith('/') && iprefix) {
                    return require('path').join(iprefix, includePath);
                  }
                  return includePath;
                })
                .filter((path: string) => path.length > 0);
              includePaths.push(...additionalIncludes);
              channel.appendLine(`Added ${additionalIncludes.length} paths from includes.txt`);
            } catch (err) {
              channel.appendLine(`Warning: Could not read includes file ${includesFile}: ${err}`);
            }
          }
        });

        channel.appendLine(`Extracted ${includePaths.length} include paths from compilation:`);
        includePaths.forEach(path => channel.appendLine(`  - ${path}`));

        const firstGpp = parts.find(p => p.includes('g++'));
        if (firstGpp) {
          compilerPath = firstGpp;

          // Detect compiler architecture and set paths accordingly
          if (compilerPath.includes('arm-none-eabi-g++')) {
            // ARM Cortex-M compiler paths (Uno R4, Zero, MKR series, RP2040, etc.)
            const armIncludeDir = path.join(path.dirname(compilerPath), '../arm-none-eabi/include');
            const armGccIncludeDir = path.join(path.dirname(compilerPath), '../lib/gcc/arm-none-eabi');

            includePaths.push(armIncludeDir);

            // Find the actual GCC version directory for ARM
            try {
              const gccVersionDirs = await fs.readdir(armGccIncludeDir);
              if (gccVersionDirs.length > 0) {
                const armGccVersionDir = path.join(armGccIncludeDir, gccVersionDirs[0], 'include');
                includePaths.push(armGccVersionDir);
              }
            } catch (err) {
              channel.appendLine(`Warning: Could not find ARM GCC include directory: ${err}`);
            }
          } else if (compilerPath.includes('xtensa-esp32-elf-g++')) {
            // ESP32 compiler paths
            const esp32IncludeDir = path.join(path.dirname(compilerPath), '../xtensa-esp32-elf/include');
            const esp32GccIncludeDir = path.join(path.dirname(compilerPath), '../lib/gcc/xtensa-esp32-elf');

            includePaths.push(esp32IncludeDir);

            // Find GCC version directory for ESP32
            try {
              const gccVersionDirs = await fs.readdir(esp32GccIncludeDir);
              if (gccVersionDirs.length > 0) {
                const esp32GccVersionDir = path.join(esp32GccIncludeDir, gccVersionDirs[0], 'include');
                includePaths.push(esp32GccVersionDir);
              }
            } catch (err) {
              channel.appendLine(`Warning: Could not find ESP32 GCC include directory: ${err}`);
            }
          } else if (compilerPath.includes('xtensa-lx106-elf-g++')) {
            // ESP8266 compiler paths
            const esp8266IncludeDir = path.join(path.dirname(compilerPath), '../xtensa-lx106-elf/include');
            const esp8266GccIncludeDir = path.join(path.dirname(compilerPath), '../lib/gcc/xtensa-lx106-elf');

            includePaths.push(esp8266IncludeDir);

            // Find GCC version directory for ESP8266
            try {
              const gccVersionDirs = await fs.readdir(esp8266GccIncludeDir);
              if (gccVersionDirs.length > 0) {
                const esp8266GccVersionDir = path.join(esp8266GccIncludeDir, gccVersionDirs[0], 'include');
                includePaths.push(esp8266GccVersionDir);
              }
            } catch (err) {
              channel.appendLine(`Warning: Could not find ESP8266 GCC include directory: ${err}`);
            }
          } else if (compilerPath.includes('riscv32-esp-elf-g++')) {
            // RISC-V compiler paths (ESP32-C3, etc.)
            const riscvIncludeDir = path.join(path.dirname(compilerPath), '../riscv32-esp-elf/include');
            const riscvGccIncludeDir = path.join(path.dirname(compilerPath), '../lib/gcc/riscv32-esp-elf');

            includePaths.push(riscvIncludeDir);

            // Find GCC version directory for RISC-V
            try {
              const gccVersionDirs = await fs.readdir(riscvGccIncludeDir);
              if (gccVersionDirs.length > 0) {
                const riscvGccVersionDir = path.join(riscvGccIncludeDir, gccVersionDirs[0], 'include');
                includePaths.push(riscvGccVersionDir);
              }
            } catch (err) {
              channel.appendLine(`Warning: Could not find RISC-V GCC include directory: ${err}`);
            }
          } else {
            // AVR compiler paths (traditional Arduino boards)
            const includeDir = path.join(path.dirname(compilerPath), '../avr/include');
            const gccIncludeDir = path.join(path.dirname(compilerPath), '../lib/gcc/avr/7.3.0/include');

            includePaths.push(
              includeDir,
              gccIncludeDir
            );
          }

          const mmcu = parts.find(p => p.startsWith('-mmcu='))?.split('=')[1] || 'atmega2560';

          // First, get standard library defines to filter them out later
          const stdLibProc = spawn(compilerPath, [
            '-dM',
            '-E',
            '-x', 'c++',
            '-'
          ]);

          // Include only standard headers to identify standard defines
          stdLibProc.stdin.write('#include <stdint.h>\n#include <stdlib.h>\n#include <string.h>\n#include <stdio.h>\n');
          stdLibProc.stdin.end();

          let stdLibOutput = '';
          stdLibProc.stdout.on('data', data => stdLibOutput += data.toString());

          stdLibProc.on('close', () => {
            // Parse standard library macros to exclude them
            const stdLibDefines = new Set(
              stdLibOutput
                .split('\n')
                .filter(line => line.startsWith('#define '))
                .map(line => {
                  const match = line.match(/#define\s+(\w+)(?:\s+|$)/);
                  return match ? match[1] : null;
                })
                .filter((d): d is string => d !== null)
            );

            channel.appendLine(`Found ${stdLibDefines.size} standard library defines to exclude`);

            // Now get Arduino and hardware-specific defines
            let defineArgs: string[] = ['-dM', '-E', '-x', 'c++'];
            let includeHeaders = '';

            if (compilerPath.includes('arm-none-eabi-g++')) {
              // ARM-specific setup - use ALL include paths from compilation
              includePaths.forEach(includePath => {
                defineArgs.push(`-I${includePath}`);
              });
              // Use Arduino core headers for ARM
              includeHeaders = '#include <Arduino.h>\n';
            } else if (compilerPath.includes('xtensa-esp32-elf-g++')) {
              // ESP32-specific setup
              includePaths.forEach(includePath => {
                defineArgs.push(`-I${includePath}`);
              });
              // Use ESP32 core headers
              includeHeaders = '#include <Arduino.h>\n#include <esp32-hal.h>\n';
            } else if (compilerPath.includes('xtensa-lx106-elf-g++')) {
              // ESP8266-specific setup
              includePaths.forEach(includePath => {
                defineArgs.push(`-I${includePath}`);
              });
              // Use ESP8266 core headers
              includeHeaders = '#include <Arduino.h>\n#include <ESP8266WiFi.h>\n';
            } else if (compilerPath.includes('riscv32-esp-elf-g++')) {
              // RISC-V (ESP32-C3, etc.) setup
              includePaths.forEach(includePath => {
                defineArgs.push(`-I${includePath}`);
              });
              // Use RISC-V ESP core headers
              includeHeaders = '#include <Arduino.h>\n#include <esp32-hal.h>\n';
            } else {
              // AVR-specific setup
              defineArgs.push(`-mmcu=${mmcu}`);
              includePaths.forEach(includePath => {
                defineArgs.push(`-I${includePath}`);
              });
              includeHeaders = '#include <avr/io.h>\n';
            }

            defineArgs.push('-');

            const defineProc = spawn(compilerPath, defineArgs);

            // Include appropriate headers based on compiler type
            defineProc.stdin.write(includeHeaders);
            defineProc.stdin.end();

            let defineOutput = '';
            defineProc.stdout.on('data', data => defineOutput += data.toString());

            defineProc.on('close', () => {
              // Parse Arduino/hardware macros
              const hardwareDefines = defineOutput
                .split('\n')
                .filter(line => line.startsWith('#define '))
                .map(line => {
                  const match = line.match(/#define\s+(\w+)(?:\s+|$)/);
                  return match ? match[1] : null;
                })
                .filter((d): d is string => d !== null)
                // Filter out standard library defines
                .filter(define => !stdLibDefines.has(define));

              // Add hardware defines and command line defines
              defines.push(...hardwareDefines);

              channel.appendLine(`Added ${hardwareDefines.length} hardware-specific defines after filtering`);

              resolve({
                includePaths,
                defines: [...new Set(defines)],
                compilerPath
              });
            });
          });
        }
      } else {
        channel.appendLine('No compiler command found in output');
        resolve(null);
      }
    });
  });
}

function getIntelliSenseMode(compilerPath: string): string {
  if (compilerPath.includes('arm-none-eabi-g++')) {
    return 'gcc-arm';
  } else if (compilerPath.includes('xtensa-esp32-elf-g++')) {
    return 'gcc-x64'; // ESP32 uses x64 mode
  } else if (compilerPath.includes('xtensa-lx106-elf-g++')) {
    return 'gcc-x64'; // ESP8266 uses x64 mode
  } else if (compilerPath.includes('riscv32-esp-elf-g++')) {
    return 'gcc-x64'; // RISC-V uses x64 mode
  } else {
    return 'gcc-x64'; // AVR and default
  }
}

export function deactivate() { }