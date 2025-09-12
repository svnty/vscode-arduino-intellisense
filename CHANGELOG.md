# Change Log

All notable changes to the "vscode-arduino-intellisense" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.3] - 2025-12-09

### Fixed
- **Advanced define filtering**: Implemented sophisticated filtering to remove problematic standard library and compiler-specific defines
- Added comprehensive skip patterns to exclude `__STDC`, `__GNUC`, `__VERSION`, `__cplusplus`, and other verbose compiler defines
- Now filters out function-like macros and complex defines that can cause IntelliSense conflicts
- Only includes simple defines and Arduino-specific defines for cleaner IntelliSense
- Improved logging to show filtering statistics (total found → filtered → essential added)

### Changed  
- Enhanced define extraction to match official vscode-arduino extension approach
- More selective filtering prevents IntelliSense from being overwhelmed with unnecessary symbols

## [0.1.2] - 2025-12-09

### Fixed
- **Major IntelliSense improvement**: Fixed defines array by extracting only compilation-relevant defines from arduino-cli output instead of dumping all preprocessor defines
- Removed overwhelming number of standard library defines that were causing IntelliSense conflicts
- Now extracts -D flags directly from compilation command line for cleaner, more accurate configuration
- Added forced includes for Arduino.h to make Arduino symbols available without explicit include
- Added essential Arduino defines (USBCON, ARDUINO_ARCH_RENESAS_UNO for ARM boards)

### Changed
- Simplified define extraction process following official vscode-arduino extension approach
- Improved logging to show count of compilation vs essential defines

## [Unreleased]

- Initial release