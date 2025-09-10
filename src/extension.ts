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
let _doc: vscode.TextDocument | null = null;

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
        if (!doc.fileName.endsWith('.ino')) return;
        if (doc.fileName.endsWith('.cpp')) return;
        _doc = doc;

        channel.appendLine(`Saved file, regenerating IntelliSense for ${doc.fileName}`);
        regenerateIntellisense(doc.fileName, channel);
    });

    vscode.workspace.onDidOpenTextDocument(doc => {
        if (!doc.fileName.endsWith('.ino')) return;
        if (doc.fileName.endsWith('.cpp')) return;
        _doc = doc;

        const lines = doc.getText().split(/\r?\n/);
        includeCache[doc.fileName] = lines
            .filter(line => /^\s*(?:\/\/\s*)?#include/.test(line))
            .map(l => l.trim())
            .join('\n');

        includeActiveCache[doc.fileName] = lines
            .filter(line => /^\s*#include/.test(line))
            .map(l => l.trim())
            .join('\n');

        channel.appendLine(`Opened file, regenerating IntelliSense for ${doc.fileName}`);
        regenerateIntellisense(doc.fileName, channel);
    });

    // Watch for changes in Arduino sketches
    vscode.workspace.onDidChangeTextDocument(event => {
        const doc = event.document;
        if (!doc.fileName.endsWith('.ino')) return;
        if (doc.fileName.endsWith('.cpp')) return;
        _doc = doc;

        if (!debouncedRegenerate[doc.fileName]) {
            debouncedRegenerate[doc.fileName] = debounce(() => regenerateIntellisense(doc.fileName, channel), 1000);
        }

        // Always use the current document text to find active (uncommented) includes
        const text = doc.getText();
        const activeIncludeLines = text.split(/\r?\n/).filter(line => /^\s*#include/.test(line));
        
        if (!activeIncludeLines.length) {
            // No active includes found, don't regenerate
            return;
        }

        const activeIncludeStatements = activeIncludeLines.map(line => {
            const match = line.match(/^\s*#include\s+[<"]([^>"]+)[>"]/);
            return match ? match[1] : null;
        }).filter((name): name is string => name !== null);

        // Update active includes cache with the current state
        const newActiveIncludes = activeIncludeStatements.join('\n');
        const oldActive = includeActiveCache[doc.fileName] || '';

        if (newActiveIncludes !== oldActive) {
            includeActiveCache[doc.fileName] = newActiveIncludes;
            channel.appendLine(`Include changed in memory, regenerating IntelliSense for ${doc.fileName}`);
            channel.appendLine(`Active includes: ${activeIncludeStatements.join(', ')}`);
            debouncedRegenerate[doc.fileName]();
        }
    });

    // Handle newly opened sketches
    vscode.workspace.onDidOpenTextDocument(doc => {
        if (!doc.fileName.endsWith('.ino')) return;
        if (doc.fileName.endsWith('.cpp')) return;
        includeCache[doc.fileName] = (doc.getText().match(/^#include.*$/gm) || []).join('\n');
        regenerateIntellisense(doc.fileName, channel);
    });

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
                    intelliSenseMode: 'gcc-x64'
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
            const sketchContent = _doc ? _doc.getText() : await fs.readFile(sketchPath, 'utf8');
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
                        channel.appendLine(`✅ Copied local header to: ${targetPath}`);
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

            if (stderr) channel.appendLine(`arduino-cli error: ${stderr}`);

            const includePaths: string[] = [];
            const defines: string[] = [];
            let compilerPath = '';

            const gppLines = stdout.split(/\r?\n/).filter(l => l.includes('avr-g++') || l.includes('arm-none-eabi-g++'));
            if (gppLines.length > 0) {
                const lastLine = gppLines[gppLines.length - 1];
                const parts = lastLine.split(' ');

                parts.forEach(p => {
                    if (p.startsWith('-I')) includePaths.push(p.substring(2));
                    if (p.startsWith('-D')) defines.push(p.substring(2));
                });

                const firstGpp = parts.find(p => p.includes('g++'));
                if (firstGpp) {
                    compilerPath = firstGpp;

                    // Get the include directories from the compiler
                    const includeDir = path.join(path.dirname(compilerPath), '../avr/include');
                    const gccIncludeDir = path.join(path.dirname(compilerPath), '../lib/gcc/avr/7.3.0/include');
                    const mmcu = parts.find(p => p.startsWith('-mmcu='))?.split('=')[1] || 'atmega2560';

                    // Add the standard compiler include paths
                    includePaths.push(
                        includeDir,
                        gccIncludeDir
                    );

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
                        const defineProc = spawn(compilerPath, [
                            '-dM',
                            '-E',
                            '-x', 'c++',
                            `-mmcu=${mmcu}`,
                            `-I${includeDir}`,
                            `-I${gccIncludeDir}`,
                            '-'
                        ]);

                        // Include only AVR/Arduino headers, not standard C/C++ headers
                        defineProc.stdin.write('#include <avr/io.h>\n');
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

export function deactivate() { }