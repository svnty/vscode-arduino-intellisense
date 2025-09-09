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
const boardCache: { [workspace: string]: string } = {};
const propertiesCache: { [fqbn: string]: BoardProperties } = {};
const debouncedRegenerate: { [file: string]: () => void } = {};

export function activate(context: vscode.ExtensionContext) {
    const channel = vscode.window.createOutputChannel('Arduino IntelliSense');
    channel.show(true);

    const workspaceFolders = vscode.workspace.workspaceFolders || [];
    workspaceFolders.forEach(folder => watchArduinoJson(folder.uri.fsPath));

    // Watch for changes in Arduino sketches
    vscode.workspace.onDidChangeTextDocument(event => {
        const doc = event.document;
        if (!doc.fileName.endsWith('.ino')) return;

        if (!debouncedRegenerate[doc.fileName]) {
            debouncedRegenerate[doc.fileName] = debounce(() => regenerateIntellisense(doc.fileName, channel), 1000);
        }

        // Only regenerate if includes have changed
        const includes = (doc.getText().match(/^#include.*$/gm) || []).join('\n');
        const oldIncludes = includeCache[doc.fileName] || '';
        if (includes !== oldIncludes) {
            includeCache[doc.fileName] = includes;
            channel.appendLine(`Include changed, regenerating IntelliSense for ${doc.fileName}`);
            debouncedRegenerate[doc.fileName]();
        }
    });

    // Handle newly opened sketches
    vscode.workspace.onDidOpenTextDocument(doc => {
        if (!doc.fileName.endsWith('.ino')) return;
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

        // Get board properties
        channel.appendLine(`Getting properties for board ${FQBN}...`);
        const props = await getBoardProperties(FQBN, sketchPath, channel);
        
        if (!props) {
            channel.appendLine('Failed to get board properties');
            return;
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
    }
}

async function getBoardProperties(FQBN: string, sketchPath: string, channel: vscode.OutputChannel): Promise<BoardProperties | null> {
    return new Promise((resolve) => {
        // First get basic compilation info
        const args = ['compile', '--fqbn', FQBN, sketchPath, '--verbose'];
        const proc = spawn('arduino-cli', args);
        let stdout = '';
        let stderr = '';
        
        proc.stdout.on('data', data => stdout += data.toString());
        proc.stderr.on('data', data => stderr += data.toString());

        proc.on('close', async () => {
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

export function deactivate() {}
