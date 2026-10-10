import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('vanish', {
  scan: () => ipcRenderer.invoke('vanish:scan'),
  clean: (kinds?: string[]) => ipcRenderer.invoke('vanish:clean', kinds),
});