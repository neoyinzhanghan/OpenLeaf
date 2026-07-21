type Props = {
  path: string;
  contentType: string;
  size: number;
  base64: string;
  onReplace: (file: File) => void;
  onEditAsText: () => void;
  onEditAsBase64: () => void;
};

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function BinaryPane({
  path,
  contentType,
  size,
  base64,
  onReplace,
  onEditAsText,
  onEditAsBase64,
}: Props) {
  const isImage = contentType.startsWith("image/");
  const dataUrl = isImage ? `data:${contentType};base64,${base64}` : null;

  return (
    <div className="binary-pane">
      <div className="pane-title">Binary</div>
      <div className="binary-meta">
        <strong>{path}</strong>
        <span>
          {contentType} · {formatSize(size)}
        </span>
      </div>
      {dataUrl && (
        <div className="binary-preview">
          <img src={dataUrl} alt={path} />
        </div>
      )}
      {!dataUrl && (
        <p className="empty-hint" style={{ paddingTop: "0.5rem" }}>
          Binary file — replace via upload, or force-open as text / base64.
        </p>
      )}
      <div className="binary-actions">
        <label className="btn btn-primary">
          Replace file…
          <input
            type="file"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onReplace(file);
              e.currentTarget.value = "";
            }}
          />
        </label>
        <button type="button" className="btn" onClick={onEditAsText}>
          Edit as text
        </button>
        <button type="button" className="btn" onClick={onEditAsBase64}>
          Edit as base64
        </button>
      </div>
    </div>
  );
}
