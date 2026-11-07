import { useEffect, type CSSProperties, type ReactNode } from "react";
import { isTransientPdfErrorMessage } from "../lib/transientErrors";

type Props = {
  children: ReactNode;
  onDismiss: () => void;
  /** Defaults to error-banner; use library-error in Library/Facts chrome. */
  className?: string;
  style?: CSSProperties;
};

/** Red alert strip with an explicit dismiss control — errors should not stick forever. */
export function ErrorBanner({ children, onDismiss, className = "error-banner", style }: Props) {
  const text = typeof children === "string" ? children : null;

  // PDF.js worker races while flipping papers — auto-clear, don't block the UI.
  useEffect(() => {
    if (text && isTransientPdfErrorMessage(text)) onDismiss();
  }, [text, onDismiss]);

  if (text && isTransientPdfErrorMessage(text)) return null;

  return (
    <div className={`error-banner-row ${className}`.trim()} role="alert" style={style}>
      <div className="error-banner-body">{children}</div>
      <button type="button" className="error-banner-dismiss" aria-label="Dismiss error" title="Dismiss" onClick={onDismiss}>
        Close
      </button>
    </div>
  );
}
