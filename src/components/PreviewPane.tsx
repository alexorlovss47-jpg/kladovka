/** Панель быстрого просмотра: изображение, PDF, текст или информация. */

import type { Dict } from "../i18n";
import { fmtSizeWith, fmtDate, iconFor } from "../format";
import type { Entry, PreviewInfo, TextPreview } from "../types";

type Props = {
  t: Dict;
  /** Выбранная запись (одна) или null. */
  entry: Entry | null;
  info: PreviewInfo | null;
  text: TextPreview | null;
  loading: boolean;
  error: string | null;
  imageUrl: string | null;
  onLoadText: () => void;
  onOpen: () => void;
  onReveal: () => void;
  onClose: () => void;
};

const KIND_LABEL: Record<string, keyof Dict> = {
  image: "kindImage",
  pdf: "kindPdf",
  text: "kindText",
  binary: "kindBinary",
  directory: "kindDirectory",
  symlink: "kindSymlink",
  other: "kindOther",
};

export function PreviewPane({
  t,
  entry,
  info,
  text,
  loading,
  error,
  imageUrl,
  onLoadText,
  onOpen,
  onReveal,
  onClose,
}: Props) {
  const fmtSize = fmtSizeWith(t);

  const kindText = info ? t[KIND_LABEL[info.kind] ?? "kindOther"] : "";
  const dims = info?.image_dimensions;

  return (
    <aside className="preview-pane">
      <div className="pv-head">
        <span className="pv-title">{t.preview}</span>
        <button className="pv-close" onClick={onClose} title={t.close}>
          ✕
        </button>
      </div>

      {!entry && !loading && <div className="pv-empty">{t.previewEmpty}</div>}
      {loading && <div className="pv-empty">{t.loading}</div>}
      {error && <div className="pv-error">{error}</div>}

      {info && !loading && !error && (
        <>
          <div className="pv-body">
            {imageUrl && (
              <div className="pv-image-wrap">
                <img className="pv-image" src={imageUrl} alt={info.name} />
              </div>
            )}

            {info.kind === "pdf" && (
              <div className="pv-placeholder">
                <div className="pv-big-ico">📕</div>
                {info.pdf_pages !== null ? (
                  <div className="pv-pages">
                    {info.pdf_pages} {t.pages}
                  </div>
                ) : (
                  <div className="pv-dim">{t.pagesUnknown}</div>
                )}
              </div>
            )}

            {info.kind === "text" && (
              <>
                {text ? (
                  <pre className="pv-text">{text.content}</pre>
                ) : info.too_large ? (
                  <div className="pv-placeholder">
                    <div className="pv-big-ico">📄</div>
                    <div className="pv-dim">
                      {t.tooLarge} ({fmtSize(info.size)})
                    </div>
                    <button className="pv-btn" onClick={onLoadText}>
                      {t.loadAnyway}
                    </button>
                  </div>
                ) : (
                  <div className="pv-empty">{t.loading}</div>
                )}
                {text?.truncated && (
                  <div className="pv-truncated">
                    {t.shown} {fmtSize(text.bytes_read)} {t.of} {fmtSize(text.size)}
                  </div>
                )}
              </>
            )}

            {info.kind === "binary" && (
              <div className="pv-placeholder">
                <div className="pv-big-ico">📦</div>
                <div className="pv-dim">{t.noPreviewBinary}</div>
              </div>
            )}

            {info.kind === "directory" && (
              <div className="pv-placeholder">
                <div className="pv-big-ico">📁</div>
                <div className="pv-dim">{t.previewFolderHint}</div>
              </div>
            )}

            {info.kind === "symlink" && (
              <div className="pv-placeholder">
                <div className="pv-big-ico">🔗</div>
                <div className="pv-link" title={info.link_target ?? ""}>
                  → {info.link_target}
                </div>
              </div>
            )}

            {info.kind === "other" && (
              <div className="pv-placeholder">
                <div className="pv-big-ico">{entry ? iconFor(entry) : "📃"}</div>
                <div className="pv-dim">{t.noPreviewBinary}</div>
              </div>
            )}
          </div>

          <div className="pv-info">
            <div className="pv-name" title={info.name}>
              {info.name}
            </div>
            <dl className="pv-list">
              <dt>{t.infoKind}</dt>
              <dd>
                {kindText}
                {info.extension ? ` · .${info.extension}` : ""}
              </dd>

              <dt>{t.infoSize}</dt>
              <dd>{info.size !== null ? fmtSize(info.size) : t.notApplicable}</dd>

              {dims && (
                <>
                  <dt>{t.infoDimensions}</dt>
                  <dd>
                    {dims[0]} × {dims[1]} {t.px}
                  </dd>
                </>
              )}

              {info.pdf_pages !== null && (
                <>
                  <dt>{t.pages}</dt>
                  <dd>{info.pdf_pages}</dd>
                </>
              )}

              <dt>{t.infoModified}</dt>
              <dd>{info.modified ? fmtDate(info.modified) : t.notApplicable}</dd>

              {info.created !== null && info.created !== info.modified && (
                <>
                  <dt>{t.infoCreated}</dt>
                  <dd>{fmtDate(info.created)}</dd>
                </>
              )}

              <dt>{t.infoLocation}</dt>
              <dd className="pv-path" title={info.path}>
                {info.path}
              </dd>
            </dl>
          </div>

          <div className="pv-actions">
            <button className="pv-btn" onClick={onOpen}>
              {t.open}
            </button>
            <button className="pv-btn" onClick={onReveal}>
              {t.revealInFinder}
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
