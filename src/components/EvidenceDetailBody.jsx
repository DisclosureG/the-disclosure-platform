import { STATUS_LABEL } from '../evidence-data';
import WhoVoted from './WhoVoted';

// Status badge used inside the detail card (kept for the modal grammar). An
// explicit `label` overrides the status→label map (used by the Peer Review
// preview, where the record is still in review rather than canon).
function EvidenceBadge({ status, label }) {
  const map = {
    queued:     { label: 'In peer review', cls: 'ev-badge-pending'    },
    pending:    { label: 'In peer review', cls: 'ev-badge-pending'    },
    canon:      { label: 'Canon',      cls: 'ev-badge-reaffirmed' },
    approved:   { label: 'Canon',      cls: 'ev-badge-reaffirmed' },
    contested:  { label: 'Contested',  cls: 'ev-badge-contested'  },
    deprecated: { label: 'Deprecated', cls: 'ev-badge-deprecated' },
    reaffirmed: { label: 'Reaffirmed', cls: 'ev-badge-reaffirmed' },
  };
  const cfg = label ? { label, cls: 'ev-badge-pending' } : map[status];
  if (!cfg) return null;
  return <span className={`ev-status-badge ${cfg.cls}`}>{cfg.label}</span>;
}

// Presentational body of the public archive's evidence record — shared by the
// archive's DetailModal and the Peer Review queue preview so a reviewer sees the
// record exactly as it will appear in the archive. Renders eyebrow → title →
// source → notices → body → meta → tags → link. Callers wrap it in their own
// modal chrome (close button, id footer, challenge controls).
export default function EvidenceDetailBody({ e, statusLabel }) {
  if (!e) return null;
  const tierLabel = e.tier === 1 ? 'I' : e.tier === 2 ? 'II' : 'III';
  const tierDesc  = e.tier === 1 ? 'I — Peer-reviewed / Declassified' : e.tier === 2 ? 'II — Documented / Institutional' : 'III — Testimony / First-person';
  const isContested  = e.status === 'contested';
  const isDeprecated = e.status === 'deprecated';

  return (
    <>
      <div className="ev-detail-eyebrow">
        <span className="ev-type">{e.type}</span>
        <span className="ev-tier" data-tier={e.tier}>
          <span className="bar"><i /><i /><i /></span>
          Tier {tierLabel}
        </span>
        <EvidenceBadge status={e.status} label={statusLabel} />
      </div>

      <h3 className={`ev-detail-title${isDeprecated ? ' ev-detail-title-deprecated' : ''}`}>{e.title}</h3>
      <p className="ev-detail-src">
        <span>{e.source}</span> · <span className="year">{e.year}</span>
      </p>

      {/* Deprecated notice */}
      {isDeprecated && (
        <div className="ev-deprecated-notice">
          <div className="ev-deprecated-notice-label">Deprecated by the network</div>
          <p>{e.deprecated_reason || e.challenge_reason || 'This evidence was challenged and deprecated by a supermajority of peers.'}</p>
          {e.deprecated_at && (
            <div className="ev-deprecated-notice-date">
              {new Date(e.deprecated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
            </div>
          )}
        </div>
      )}

      {/* Contested notice */}
      {isContested && e.challenge_reason && (
        <div className="ev-contested-notice">
          <div className="ev-contested-notice-label">Under challenge</div>
          <p>{e.challenge_reason}</p>
          <a href="/peer-review/" className="ev-contested-notice-link">
            Vote in Peer Review →
          </a>
        </div>
      )}

      <div className="ev-detail-body">
        <p>{e.excerpt}</p>
        {e.body && <p>{e.body}</p>}
        {e.quote && <p className="ev-detail-quote">&ldquo;{e.quote}&rdquo;</p>}
      </div>

      <div className="ev-detail-meta-block">
        <dl className="ev-detail-meta">
          <dt>Pillar</dt><dd>{e.pillarTitle}</dd>
          {e.topicTitle && <><dt>Topic</dt><dd>{e.topicTitle}</dd></>}
          <dt>Type</dt><dd>{e.type}</dd>
          <dt>Tier</dt><dd>{tierDesc}</dd>
          <dt>Status</dt><dd>{statusLabel || STATUS_LABEL[e.status] || 'In peer review'}</dd>
        </dl>
        <WhoVoted evidenceId={e.id} />
      </div>

      {e.tags && e.tags.length > 0 && (
        <div className="ev-detail-tag-row">
          <span className="ev-detail-tag-label">Tags</span>
          {e.tags.map(t => (
            <a key={t} href="#" onClick={(ev) => ev.preventDefault()}>{t}</a>
          ))}
        </div>
      )}

      {e.link && e.link !== '#' && (
        <a href={e.link} target="_blank" rel="noopener noreferrer" className="ev-detail-cta">
          Open source <span>↗</span>
        </a>
      )}
    </>
  );
}
