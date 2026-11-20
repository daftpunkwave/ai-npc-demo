/**
 * 渲染设备级展示偏好、镜头缩放边界与 campaign 存档操作。
 * 依赖本地偏好端口和世界视图；不把偏好写入 run manifest 或改变规则结果。
 * 禁止伪造服务端保存成功，也禁止提供后台模型或装配入口。
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  usePort,
  usePreferencePort,
  type BrowserViewPort,
} from "@ai-npc/client-sdk";
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";

interface CameraLike {
  zoomTo(zoom: number): void;
}

interface WorldViewLike {
  pause(): Promise<void>;
  resume(): Promise<void>;
  save(label: string): Promise<void>;
  getSnapshot(): unknown;
}

function SettingsView(): ReactNode {
  const preferences = usePreferencePort();
  const camera = usePort<CameraLike>("client.camera");
  const worldView = usePort<WorldViewLike>("client.world-view");
  const [open, setOpen] = useState(false);
  const [fontSize, setFontSize] = useState(String(preferences.get("display")?.fontSize ?? "medium"));
  const [contrast, setContrast] = useState(preferences.get("display")?.contrast === true);
  const [zoom, setZoom] = useState(Number(preferences.get("camera")?.zoom ?? 1));
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const pixels = fontSize === "small" ? "14px" : fontSize === "large" ? "18px" : "16px";
    const document = (globalThis as unknown as {
      readonly document?: {
        readonly documentElement: {
          readonly style: { fontSize: string };
          readonly dataset: { contrast: string };
        };
      };
    }).document;
    if (document !== undefined) {
      document.documentElement.style.fontSize = pixels;
      document.documentElement.dataset.contrast = contrast ? "high" : "normal";
    }
  }, [contrast, fontSize]);

  const persistDisplay = (nextFontSize: string, nextContrast: boolean): void => {
    preferences.set("display", { fontSize: nextFontSize, contrast: nextContrast });
  };

  const runGameAction = async (kind: "pause" | "resume" | "save"): Promise<void> => {
    setNotice(null);
    try {
      if (kind === "pause") {
        await worldView.pause();
        setNotice("时钟已暂停");
      } else if (kind === "resume") {
        await worldView.resume();
        setNotice("时钟已继续");
      } else {
        await worldView.save("玩家设置面板存档");
        setNotice("存档已创建");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <>
      <button
        type="button"
        className="settings-trigger"
        data-testid="hud-settings"
        aria-label="打开设置"
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">⌁</span>
      </button>
      {open ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
          <section
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="eyebrow">本机偏好</span>
                <h2 id="settings-title">设置</h2>
              </div>
              <button type="button" className="icon-button" aria-label="关闭设置" onClick={() => setOpen(false)}>
                ×
              </button>
            </header>
            <div className="settings-grid">
              <label>
                <span>字号</span>
                <select
                  value={fontSize}
                  onChange={(event) => {
                    const value = (event.currentTarget as unknown as { value: string }).value;
                    setFontSize(value);
                    persistDisplay(value, contrast);
                  }}
                >
                  <option value="small">小</option>
                  <option value="medium">中</option>
                  <option value="large">大</option>
                </select>
              </label>
              <label className="switch-row">
                <span>高对比度</span>
                <input
                  type="checkbox"
                  checked={contrast}
                  onChange={(event) => {
                    const checked = (event.currentTarget as unknown as { checked: boolean }).checked;
                    setContrast(checked);
                    persistDisplay(fontSize, checked);
                  }}
                />
              </label>
              <label>
                <span>镜头缩放</span>
                <input
                  type="range"
                  min="0.5"
                  max="2"
                  step="0.1"
                  value={zoom}
                  onChange={(event) => {
                    const value = Number(
                      (event.currentTarget as unknown as { value: string }).value,
                    );
                    setZoom(value);
                    camera.zoomTo(value);
                    preferences.set("camera", { zoom: value });
                  }}
                />
                <output>{zoom.toFixed(1)}×</output>
              </label>
              <div className="settings-disabled">
                <span>声音</span>
                <strong>声音模块未装载</strong>
              </div>
            </div>
            <div className="settings-actions">
              <button type="button" onClick={() => void runGameAction("pause")}>暂停世界</button>
              <button type="button" onClick={() => void runGameAction("resume")}>继续世界</button>
              <button type="button" onClick={() => void runGameAction("save")}>创建存档</button>
            </div>
            {notice === null ? null : <p className="settings-notice" role="status">{notice}</p>}
            <footer>
              语言固定为简体中文。偏好保存在本机，不改变世界规则或当前运行装配。
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}

export function createSettingsModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const port: BrowserViewPort = { renderContribution: () => <SettingsView /> };
  return Promise.resolve({
    moduleId: input.moduleId,
    start: async () => undefined,
    drain: async () => undefined,
    dispose: async () => undefined,
    port,
  });
}
