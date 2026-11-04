// 録音からメモを作るのは PC だけ（プログラムで決める）。スマホ・タブレットでは入口を出さない。

export type DeviceInfo = {
  userAgent: string;
  maxTouchPoints: number;
  /** 横幅が PC の3列の幅（1024px）以上か */
  wideScreen: boolean;
  /** マウスなどの細かく指せる物が主か */
  finePointer: boolean;
};

const MOBILE = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|BlackBerry|Opera Mini|IEMobile/i;

export function isPcDevice(d: DeviceInfo): boolean {
  if (MOBILE.test(d.userAgent)) return false;
  // iPad は Mac の名前で来るので、触れる点の数で見分ける
  if (/Macintosh/.test(d.userAgent) && d.maxTouchPoints > 1) return false;
  return d.wideScreen && d.finePointer;
}

/** 録音フォルダ（PC の Chrome・Edge の File System Access）が使えるか */
export function canWatchFolder(w: unknown): boolean {
  return !!w && typeof (w as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

/** 画面の録音（マイク）が使えるか */
export function canRecord(w: unknown): boolean {
  const n = (w as { navigator?: { mediaDevices?: { getUserMedia?: unknown } } })?.navigator;
  return typeof n?.mediaDevices?.getUserMedia === "function" && typeof (w as { MediaRecorder?: unknown }).MediaRecorder === "function";
}
