# Arduino Community Edition Intellisense
Fix intellisense for Arduino Community Edition

## Requirements
- Visual Studio Code
- Arduino Community Edition plugin

## Recommended install
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

Install libraries

Hit `Cmd + Shift + P` and type `>Arduino: Library Manager`.

Install boards

Hit `Cmd + Shift + P` and type `>Arduino: Board Manager`