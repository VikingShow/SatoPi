import { toast } from "sonner";
import { useCallback } from "react";

export function useNotifications() {
  const requestPermission = useCallback(async () => {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    const result = await Notification.requestPermission();
    return result === "granted";
  }, []);

  const notify = useCallback((title: string, body: string, silent = false) => {
    // In-app toast always shown
    toast(title, { description: body });

    // Browser notification if permitted
    if (Notification.permission === "granted" && !silent) {
      new Notification(title, { body, icon: "/favicon.ico" });
    }
  }, []);

  return { requestPermission, notify };
}
