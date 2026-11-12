# Strudel Jelly

A desktop app for [Strudel](https://strudel.cc) live coding that runs entirely on your machine.

- **Play / update:** `Ctrl+Enter`. **Stop:** `Ctrl+.` (one Play/Stop button; the tempo next to it assumes 4 beats per cycle).
- **Sketches** (file button, top right): every song is a `.js` file in `Documents\Strudel Jelly\sketches`. Pick one to open it, `Ctrl+N` starts a new one, right-click or `...` renames, duplicates or deletes (to the Recycle Bin). Your code autosaves a moment after you stop typing; `Ctrl+S` saves now. Edits made in Explorer show up automatically.
- **Visual strip:** a pianoroll of what is playing under the code. Toggle it with the button in the editor corner or in Settings.
- **Your samples** live in `Documents\Strudel Jelly\samples`. Each folder is one sound, and files inside it are `n` variations (`s("kick").n(2)`). Drop files or folders anywhere on the window, or use the buttons in the Sounds pane. Changes made in Explorer show up automatically.
- **Offline:** every sound fetched from the internet (built-in banks, soundfonts, `samples('github:...')`) is cached in `%APPDATA%\strudel-jelly\sound-cache`. **Settings → Save all sounds offline** downloads every built-in sound at once.
- **Settings** (sliders button, top right): theme, code size, line wrapping, suggestions, note highlighting, visual strip, line numbers.
- `F12` opens DevTools.

## Develop

```sh
npm install
npm run dev     # build the UI and open the app
npm run dist    # package to release/win-unpacked/Strudel Jelly.exe
```

Strudel is AGPL-3.0, so this app is too.
