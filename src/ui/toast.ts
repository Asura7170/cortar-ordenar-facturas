/* Toast de avisos (un solo timer cancelable). */
import { getEl, sleep } from '../utils';

const toastEl: HTMLElement = getEl('toast');
let toastCtrl: AbortController | null = null;

export function showToast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  toastCtrl?.abort();
  toastCtrl = new AbortController();
  void sleep(2600, { signal: toastCtrl.signal }).then(() => { toastEl.hidden = true; });
}
