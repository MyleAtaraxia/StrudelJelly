// Audio export: the renderer records what plays (src/record.js) and the result is saved where the user picks.
// With the audio engine the host writes the WAV itself (vst:recordStart / vst:recordStop in vst/host.cjs) to a temp
// file that is moved into place; without it the renderer sends the encoded WAV bytes (record:save).
const { dialog, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

let lastDir = null;

// the file name for a sketch: the sketch name without characters Windows refuses
const fileName = (name) => `${String(name || 'recording').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim() || 'recording'}.wav`;

async function askWavPath(win, app, name) {
  if (process.env.JELLY_EXPORT_DIR) return path.join(process.env.JELLY_EXPORT_DIR, fileName(name)); // tests: no dialog
  const dir = lastDir && fs.existsSync(lastDir) ? lastDir : app.getPath('music');
  const r = await dialog.showSaveDialog(win, {
    title: 'Export audio',
    defaultPath: path.join(dir, fileName(name)),
    filters: [{ name: 'WAV audio', extensions: ['wav'] }],
  });
  if (r.canceled || !r.filePath) return null;
  lastDir = path.dirname(r.filePath);
  return r.filePath;
}

// rename, or copy when the temp folder is on another drive
async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e;
    await fsp.copyFile(from, to);
    await fsp.unlink(from);
  }
}

function setupExport({ app, ipcMain, getWin }) {
  // without the engine: the renderer's own recording, already encoded as WAV
  ipcMain.handle('record:save', async (_, name, bytes) => {
    if (!(bytes instanceof Uint8Array) || bytes.length < 44) throw new Error('nothing was recorded');
    const to = await askWavPath(getWin(), app, name);
    if (!to) return null;
    await fsp.writeFile(to, bytes);
    return to;
  });
  ipcMain.handle('record:reveal', (_, file) => {
    if (typeof file === 'string' && /\.wav$/i.test(file) && fs.existsSync(file)) shell.showItemInFolder(file);
  });
}

module.exports = { setupExport, askWavPath, moveFile };
