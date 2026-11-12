# Strudel Jelly

A desktop app for [Strudel](https://strudel.cc) live coding that runs entirely on your machine.

- **Play / update:** `Ctrl+Enter`. **Stop:** `Ctrl+.` (one Play/Stop button; the tempo next to it assumes 4 beats per cycle).
- **Hot reload:** the music updates a moment after you stop typing, no `Ctrl+Enter` needed. Code that doesn't parse yet is skipped, so the last good version keeps playing. Turn it off in Settings.
- **Sketches** (file button, top right): every song is a `.js` file in `Documents\Strudel Jelly\sketches`. Pick one to open it (this stops playback; each sketch keeps its own undo history), `Ctrl+N` starts a new one, right-click or `...` renames, duplicates or deletes (to the Recycle Bin). Your code autosaves a moment after you stop typing; `Ctrl+S` saves now. Edits made in Explorer show up automatically.
- **Piano roll:** the current pattern in its own panel under the code, scrolling while it plays and a still picture while stopped. Zoom with the +/- buttons or Ctrl+wheel over it, and change the row height with the second pair of buttons or Alt+wheel. Drag it (or Shift+wheel) to look ahead or back in time, which stops it following the playhead until you press Follow; the wheel scrolls the rows when there are more than fit, and a ruler shows the cycle numbers. Rows stay put while it plays. Drag the handle between the panels to resize it (double-click resets), and turn it on or off in Settings or with `Ctrl+K`. Each `$:` block gets its own colour, shown as a bar beside its lines in the editor and on its notes; rows are labelled with the note or sound name. Hover a note to see its line and sound and light up the code that made it; click it to jump there.
- **Your samples** live in `Documents\Strudel Jelly\samples`. Each folder is one sound, and files inside it are `n` variations (`s("kick").n(2)`). Drop files or folders anywhere on the window, or use the buttons in the Sounds pane. Changes made in Explorer show up automatically.
- **Offline:** every sound fetched from the internet (built-in banks, soundfonts, `samples('github:...')`) is cached in `%APPDATA%\strudel-jelly\sound-cache`. **Settings → Save all sounds offline** downloads every built-in sound at once.
- **Status** (in the code panel's header): the current error next to the save state, and on the right a spinner while sounds are loading, the Vim mode and the cursor's line and column.
- **Editor:** Tab indents (press Esc, then Tab, to move focus out of the editor). Multiple cursors: Ctrl+click adds one, Alt+drag makes a column, Ctrl+Alt+Up/Down adds one above or below, Ctrl+D selects the next match. **Settings → Keys** switches to Vim keys (`:w` plays, `:q` stops; the code panel's header shows the Vim mode) and back.
- **Docs** (book button, top right): every Strudel function with its parameters and examples, searchable and grouped, built from Strudel's own reference so it works offline. **Play** hears an example without touching your sketch (it stops the sketch; `Ctrl+.` stops the example), **Insert** adds it below the cursor line. Hover a function in the code, or press **F1** on it, for a card with the same info. Typing `(` or `,` in a call shows its parameters above the cursor (`Ctrl+Shift+Space` brings it back, Esc hides it); More opens the Docs pane.
- **Search everything:** `Ctrl+K` finds functions, sounds, sketches and app commands in one list. Enter inserts the function or sound, opens the sketch or runs the command; `Ctrl+Enter` plays a function's first example.
- **Settings** (sliders button, top right): theme, code size, Normal or Vim keys, line wrapping, suggestions, note highlighting, hot reload, piano roll, line numbers.
- `F12` opens DevTools.

## Develop

```sh
npm install
npm run dev     # build the UI and open the app
npm run dist    # package to release/win-unpacked/Strudel Jelly.exe
```

Strudel is AGPL-3.0, so this app is too.
