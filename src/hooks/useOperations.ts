/** Очередь файловых операций: подписка на прогресс, управление. */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { playSound, type SoundSettings } from "../sounds";
import type { OpInfo, OpProgress } from "../types";

/** Период обновления списка операций (прогресс приходит событиями чаще). */
const POLL_MS = 700;

type Deps = {
  sounds: SoundSettings;
  /** Вызывается, когда операция успешно завершилась (обновить список файлов). */
  onFinished: () => void;
};

export function useOperations({ sounds, onFinished }: Deps) {
  const [ops, setOps] = useState<OpInfo[]>([]);

  const reload = useCallback(async () => {
    try {
      setOps(await invoke<OpInfo[]>("list_ops"));
    } catch {
      /* состояние могло измениться между вызовами */
    }
  }, []);

  // Прогресс: события дают мгновенную реакцию, поллинг — актуальный список.
  useEffect(() => {
    const un = listen<OpProgress>("op-progress", (ev) => {
      const p = ev.payload;
      setOps((prev) =>
        prev.map((op) =>
          op.id === p.op_id
            ? {
                ...op,
                done: p.done,
                total: p.total || op.total,
                current: p.current,
                status: p.finished
                  ? p.error
                    ? p.error === "отменено"
                      ? "cancelled"
                      : "failed"
                    : "finished"
                  : op.status === "paused"
                    ? "paused"
                    : "running",
                error: p.error,
              }
            : op,
        ),
      );
      if (p.finished) {
        playSound(p.error ? "error" : p.kind === "move" ? "move" : "copy", sounds);
        if (!p.error) onFinished();
        void reload();
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [sounds, onFinished, reload]);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  const control = useCallback(
    async (cmd: "pause_op" | "resume_op" | "cancel_op" | "remove_op", opId: number) => {
      try {
        await invoke(cmd, { opId });
        await reload();
      } catch (e) {
        console.warn(cmd, e);
      }
    },
    [reload],
  );

  const active = ops.filter((o) => o.status === "running" || o.status === "paused" || o.status === "queued");
  const finished = ops.filter((o) => o.status === "finished" || o.status === "failed" || o.status === "cancelled");

  return { ops, active, finished, reload, pause: (id: number) => control("pause_op", id), resume: (id: number) => control("resume_op", id), cancel: (id: number) => control("cancel_op", id), dismiss: (id: number) => control("remove_op", id) };
}
