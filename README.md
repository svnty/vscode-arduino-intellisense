# Arduino Community Edition Intellisense
Fix intellisense for Arduino Community Edition

## Requirements
- Visual Studio Code
- Arduino Community Edition plugin

## Supported devices

- AVR: avr-g++ (Uno, Mega, etc.)
- ARM Cortex-M: arm-none-eabi-g++ (Uno R4, Zero, MKR, RP2040, etc.)
- ESP32: xtensa-esp32-elf-g++ (ESP32 series)
- ESP8266: xtensa-lx106-elf-g++ (ESP8266 series) 
- RISC-V: riscv32-esp-elf-g++ (ESP32-C3, CH32V, etc.)

## Installation

### Mac OS (Apple silicon)

Install arduino-cli

```bash
brew install arduino-cli
```

Initalise arduino-cli config

```bash
arduino-cli config init
```

Edit ~/Library/Arduino15/arduino-cli.yaml

```yaml
directories:
  data: ~/Library/Arduino15
  downloads: ~/Library/Arduino15/staging
  user: ~/.arduino-cli
```

Open VS-CODE user preferences (settings.json)

```json
{
  "arduino.useArduinoCli": true,
  "arduino.analyzeOnOpen": false,
  "arduino.analyzeOnSettingChange": false,
  "arduino.path": "/opt/homebrew/bin",
  "arduino.commandPath": "arduino-cli",
}
```

Run 

```bash
arduino-cli core install
```

### Windows installation (With powershell)

Download [https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_Windows_64bit.zip](https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_Windows_64bit.zip)

Create a new folder then drag the file to `C:\Program Files\Arduino CLI\`

Open VS-CODE user preferences (settings.json)

```json
{
  "arduino.useArduinoCli": true,
  "arduino.analyzeOnOpen": false,
  "arduino.analyzeOnSettingChange": false,
  "arduino.path": "C:\\Program Files\\Arduino CLI",
  "arduino.commandPath": "arduino-cli.exe"
}
```

Open powershell as an administrator and run 

```powershell
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";C:\Program Files\Arduino CLI", "Machine")
```

Run

```bash
arduino-cli core install
```

## Arduino libraries

### Install libraries

Hit `Cmd + Shift + P` and type `>Arduino: Library Manager`.

### Install boards

Hit `Cmd + Shift + P` and type `>Arduino: Board Manager`

## Error?

Try including Arduino.h in your .ino file

`#include <Arduino.h>`

## Custom settings

If the extension isn't working, try adding a custom path to your boards compiler in vscode user settings.json

### Windows specific example

```json
"arduinoIntelliSense.compilerOverrides": {
  "arm-none-eabi": [
    "C:\\Users\\X\\AppData\\Local\\Arduino15\\Packages\\arduino\\tools\\arm-none-eabi-gcc\\7-2017q4\\lib\\gcc\\arm-none-eabi\\7.2.1\\include",
    "C:\\Users\\X\\AppData\\Local\\Arduino15\\Packages\\arduino\\tools\\arm-none-eabi-gcc\\7-2017q4\\arm-none-eabi\\include"
  ],
  "avr": [
    "C:\\Users\\X\\AppData\\Local\\Arduino15\\packages\\arduino\\tools\\avr-gcc\\9.2.0-arduino3\\avr\\include"
  ]
}
```

### Mac specific example

```json
"arduinoIntelliSense.compilerOverrides": {
  "arm-none-eabi": [
    "~/Library/Arduino15/packages/arduino/tools/arm-none-eabi-gcc/7-2017q4/lib/gcc/arm-none-eabi/7.2.1/include"
  ],
  "avr": [
    "~/Library/Arduino15/packages/arduino/tools/avr-gcc/9.2.0-arduino3/avr/include"
  ]
}
```