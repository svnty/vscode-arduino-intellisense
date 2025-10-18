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

### Windows installation (With powershell)

Download `https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_Windows_64bit.zip`

Drag the file to `C:\Program Files\Arduino CLI\`

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

Open powershell as an administrator and run `[Environment]::SetEnvironmentVariable("Path", $env:Path + ";C:\Program Files\Arduino CLI", "Machine")`

## Arduino libraries

Install libraries

Hit `Cmd + Shift + P` and type `>Arduino: Library Manager`.

Install boards

Hit `Cmd + Shift + P` and type `>Arduino: Board Manager`

## Error?

Try including Arduino.h in your .ino file

`#include <Arduino.h>`