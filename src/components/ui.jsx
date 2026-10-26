import { useId } from 'react';
import clsx from 'clsx';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { Minus, Plus, X } from 'lucide-react';
import { STATUS_LABELS } from '../lib/format.js';

export function Field({ label, optional, hint, error, children, id: idProp, className }) {
  const autoId = useId();
  const id = idProp || autoId;
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <div className={clsx('field', className)}>
      <label className="field-label" htmlFor={id}>
        {label} {optional && <span className="optional">(optional)</span>}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hint && !error && (
        <span className="field-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {error && (
        <span className="field-error" id={`${id}-error`} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function Stepper({ value, onChange, min = 1, max = 99, format = (v) => v, label }) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label={`Fewer ${label?.toLowerCase() || ''}`.trim()}>
        <Minus />
      </button>
      <output aria-live="polite">{format(value)}</output>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label={`More ${label?.toLowerCase() || ''}`.trim()}>
        <Plus />
      </button>
    </div>
  );
}

export function StatusBadge({ status }) {
  return <span className={clsx('badge', `badge-${status}`)}>{STATUS_LABELS[status] || status}</span>;
}

export function Switch({ checked, onChange, label, id }) {
  return (
    <BaseSwitch.Root id={id} className="switch" checked={checked} onCheckedChange={onChange} aria-label={label}>
      <BaseSwitch.Thumb className="switch-thumb" />
    </BaseSwitch.Root>
  );
}

/** Standard dialog; becomes a bottom sheet on phones. */
export function Dialog({ open, onOpenChange, title, description, children, footer, wide }) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="dialog-backdrop" />
        <BaseDialog.Popup className={clsx('dialog-popup', wide && 'dialog-wide')}>
          <div className="dialog-head">
            <div>
              <BaseDialog.Title className="dialog-title">{title}</BaseDialog.Title>
              {description && <BaseDialog.Description className="dialog-desc">{description}</BaseDialog.Description>}
            </div>
            <BaseDialog.Close className="dialog-close" aria-label="Close">
              <X size={20} />
            </BaseDialog.Close>
          </div>
          {children}
          {footer && <div className="dialog-actions">{footer}</div>}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/** Asks before a destructive or hard-to-undo action. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, cancelLabel = 'Keep it', onConfirm, danger, busy }) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="dialog-backdrop" />
        <AlertDialog.Popup className="dialog-popup dialog-narrow">
          <AlertDialog.Title className="dialog-title">{title}</AlertDialog.Title>
          {description && <AlertDialog.Description className="dialog-desc">{description}</AlertDialog.Description>}
          <div className="dialog-actions">
            <AlertDialog.Close className="btn btn-outline">{cancelLabel}</AlertDialog.Close>
            <button type="button" className={clsx('btn', danger ? 'btn-danger' : 'btn-dark')} onClick={onConfirm} disabled={busy}>
              {confirmLabel}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
