"use client";

import { createContext, useContext, useState, useCallback, useRef } from "react";
import { CheckCircle2, AlertTriangle, Info, X, AlertCircle } from "lucide-react";

type ToastType = "success" | "error" | "warning" | "info";

interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  exiting?: boolean;
}

interface ToastContextValue {
  toast: (type: ToastType, title: string, message?: string) => void;
}

const ToastContext = createContext<ToastContextValue>({
  toast: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

const icons: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle2 size={16} className="text-[color:var(--success)]" />,
  error: <AlertCircle size={16} className="text-[color:var(--danger)]" />,
  warning: <AlertTriangle size={16} className="text-[color:var(--warning)]" />,
  info: <Info size={16} className="text-[color:var(--info)]" />,
};

const borderColors: Record<ToastType, string> = {
  success: "border-l-[color:var(--success)]",
  error: "border-l-[color:var(--danger)]",
  warning: "border-l-[color:var(--warning)]",
  info: "border-l-[color:var(--info)]",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counterRef = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, exiting: true } : t))
    );
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 200);
  }, []);

  const toast = useCallback(
    (type: ToastType, title: string, message?: string) => {
      const id = `toast-${++counterRef.current}`;
      setToasts((prev) => [...prev, { id, type, title, message }]);
      setTimeout(() => dismiss(id), 4500);
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed right-4 top-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`${
              t.exiting ? "animate-toast-out" : "animate-toast-in"
            } flex w-80 items-start gap-3 rounded-lg border border-l-4 ${
              borderColors[t.type]
            } border-card-border bg-[var(--bg-card)] px-4 py-3 shadow-lg`}
          >
            <span className="mt-0.5 shrink-0">{icons[t.type]}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">{t.title}</p>
              {t.message && (
                <p className="mt-0.5 text-xs text-muted leading-relaxed">{t.message}</p>
              )}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="shrink-0 rounded p-0.5 text-muted hover:bg-[var(--bg-hover)] hover:text-foreground"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
