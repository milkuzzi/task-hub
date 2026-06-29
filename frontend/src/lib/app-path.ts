import { useLocation } from "react-router-dom";

export function useIsMaxApp(): boolean {
  const location = useLocation();
  return location.pathname === "/max" || location.pathname.startsWith("/max/");
}

export function useAppPath(): (path: string) => string {
  const isMaxApp = useIsMaxApp();
  const prefix = isMaxApp ? "/max" : "";
  return (path: string): string =>
    `${prefix}${path.startsWith("/") ? path : `/${path}`}`;
}
