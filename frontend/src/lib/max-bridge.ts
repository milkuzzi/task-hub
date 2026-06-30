const MAX_BRIDGE_SRC = "https://st.max.ru/js/max-web-app.js";
const MAX_BRIDGE_SCRIPT_ID = "max-web-app-bridge";

export interface MaxBackButton {
  show(): void;
  hide(): void;
  onClick(callback: () => void): void;
  offClick(callback: () => void): void;
}

export interface MaxWebApp {
  initData: string;
  initDataUnsafe?: {
    start_param?: string;
  };
  platform?: "ios" | "android" | "desktop" | "web" | string;
  version?: string;
  BackButton?: MaxBackButton;
  openLink?: (url: string) => void;
  downloadFile?: (url: string, fileName: string) => Promise<unknown>;
}

declare global {
  interface Window {
    WebApp?: MaxWebApp;
  }
}

export function readMaxInitData(): string | null {
  const bridgeData = window.WebApp?.initData?.trim();
  if (bridgeData !== undefined && bridgeData !== "") {
    return bridgeData;
  }
  const candidates = [
    new URLSearchParams(window.location.hash.slice(1)).get("WebAppData"),
    new URLSearchParams(window.location.search).get("WebAppData"),
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return null;
}

export function clearMaxLaunchFragment(): void {
  const url = new URL(window.location.href);
  let changed = false;

  if (url.hash !== "") {
    const hashParams = new URLSearchParams(url.hash.slice(1));
    if (hashParams.has("WebAppData")) {
      hashParams.delete("WebAppData");
      url.hash = hashParams.toString() === "" ? "" : hashParams.toString();
      changed = true;
    }
  }

  if (url.searchParams.has("WebAppData")) {
    url.searchParams.delete("WebAppData");
    changed = true;
  }

  if (changed) {
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }
}

export function loadMaxBridge(): Promise<MaxWebApp | null> {
  if (window.WebApp !== undefined) {
    return Promise.resolve(window.WebApp);
  }
  return new Promise((resolve) => {
    const finish = (): void => resolve(window.WebApp ?? null);
    const existing = document.getElementById(MAX_BRIDGE_SCRIPT_ID);
    if (existing !== null) {
      existing.addEventListener("load", finish, { once: true });
      existing.addEventListener("error", () => resolve(null), { once: true });
      window.setTimeout(finish, 5000);
      return;
    }
    const script = document.createElement("script");
    script.id = MAX_BRIDGE_SCRIPT_ID;
    script.src = MAX_BRIDGE_SRC;
    script.async = true;
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", () => resolve(null), { once: true });
    document.head.append(script);
    window.setTimeout(finish, 5000);
  });
}

export function readMaxStartParam(initData: string): string | null {
  const candidates = [
    new URLSearchParams(initData).get("start_param"),
    window.WebApp?.initDataUnsafe?.start_param,
    new URLSearchParams(window.location.search).get("WebAppStartParam"),
    new URLSearchParams(window.location.hash.slice(1)).get("WebAppStartParam"),
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return null;
}

export function maxStartTaskPath(initData: string): string | null {
  const startParam = readMaxStartParam(initData);
  const match = /^task[_:]([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
    startParam ?? "",
  );
  return match?.[1] === undefined ? null : `/max/tasks/${match[1]}`;
}
