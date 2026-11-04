"use client";

// いま開いている端末が PC か（device.ts の isPcDevice）。サーバーの側ではわからないので「まだ」を返す。

import { useEffect, useState } from "react";
import { canRecord, canWatchFolder, isPcDevice } from "./device";

export type DeviceView = { known: boolean; pc: boolean; folder: boolean; record: boolean };

export function useDevice(): DeviceView {
  const [v, setV] = useState<DeviceView>({ known: false, pc: false, folder: false, record: false });
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 1024px)");
    const fine = window.matchMedia("(pointer: fine)");
    const update = () =>
      setV({
        known: true,
        pc: isPcDevice({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints ?? 0, wideScreen: wide.matches, finePointer: fine.matches }),
        folder: canWatchFolder(window),
        record: canRecord(window),
      });
    update();
    wide.addEventListener("change", update);
    fine.addEventListener("change", update);
    return () => {
      wide.removeEventListener("change", update);
      fine.removeEventListener("change", update);
    };
  }, []);
  return v;
}
