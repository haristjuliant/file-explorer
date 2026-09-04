import { createPortal } from "react-dom";

import { bindingsByGroup, prettyCombo } from "../../keys/keymap";

import "./ops.css";

/**
 * The keyboard reference, generated from the binding table.
 *
 * Nothing here is maintained by hand: because the keymap is data, this sheet
 * cannot drift out of step with what the keys actually do.
 */
export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  if (!open) return null;

  return createPortal(
    <div className="fm-modal-backdrop" role="presentation" onPointerDown={onClose}>
      <div
        className="fm-modal fm-shortcuts"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          e.stopPropagation();
        }}
      >
        <h2>Keyboard shortcuts</h2>
        <div className="fm-modal-body fm-shortcuts-body">
          {bindingsByGroup().map(([group, list]) => (
            <section key={group}>
              <h3>{group}</h3>
              <dl>
                {list.map((b) => (
                  <div key={b.id}>
                    <dt>{b.label}</dt>
                    <dd>
                      <kbd>{prettyCombo(b.combo)}</kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <div className="fm-modal-actions">
          <button type="button" className="fm-btn fm-btn--primary" onClick={onClose} autoFocus>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
