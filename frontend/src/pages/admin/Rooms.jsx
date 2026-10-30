import { useState } from 'react';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import clsx from 'clsx';
import { adminApi } from '../../lib/api.js';
import { peso } from '../../lib/format.js';
import { ConfirmDialog, Dialog, Field, Switch } from '../../components/ui.jsx';
import { LoadError, PageHead, useAdmin, useLoader } from './admin-shared.jsx';

const COLORS = ['#F2B33D', '#4FC1B0', '#F0708A', '#8C7CF0', '#6FB3F2', '#A8D46F'];

export default function Rooms() {
  const { version, changed } = useAdmin();
  const rooms = useLoader(() => adminApi.rooms(), [version]);
  const [editing, setEditing] = useState(null); // room object, or {} for a new room
  const [open, setOpen] = useState(false);

  if (rooms.error && !rooms.data) return <LoadError error={rooms.error} onRetry={rooms.reload} />;
  const list = rooms.data?.rooms;

  return (
    <div className="a-page">
      <PageHead title="Rooms" sub="Rates and gear here show on the website right away.">
        <button
          type="button"
          className="btn btn-dark"
          onClick={() => {
            setEditing({});
            setOpen(true);
          }}
        >
          <Plus /> Add room
        </button>
      </PageHead>

      {!list && <div className="skeleton" style={{ height: 180 }} />}
      {list && list.length === 0 && <p className="a-empty">No rooms yet. Add your first room so bands can book it.</p>}
      {list && list.length > 0 && (
        <ul className="room-admin-list">
          {list.map((r) => (
            <li key={r.id} className={clsx('room-admin', !r.active && 'is-hidden')} style={{ '--room': r.color }}>
              <div className="room-admin-main">
                <p className="room-admin-name">
                  <span aria-hidden="true" className="room-swatch" />
                  {r.name}
                  {!r.active && <span className="badge badge-completed">Hidden from website</span>}
                </p>
              </div>
              <dl className="room-admin-specs tnum">
                <div>
                  <dt>Rate</dt>
                  <dd>{peso(r.hourly_rate)}/hr</dd>
                </div>
                <div>
                  <dt>Fits</dt>
                  <dd>{r.capacity}</dd>
                </div>
                <div>
                  <dt>Gear</dt>
                  <dd>{r.gear.length}</dd>
                </div>
              </dl>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => {
                  setEditing(r);
                  setOpen(true);
                }}
              >
                Edit
              </button>
            </li>
          ))}
        </ul>
      )}

      <RoomDialog room={editing} open={open} onOpenChange={setOpen} onSaved={changed} />
    </div>
  );
}

function RoomDialog({ room, open, onOpenChange, onSaved }) {
  const isNew = !room?.id;
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lastRoom, setLastRoom] = useState(null);

  // Load the form when a different room is opened.
  if (open && room && room !== lastRoom) {
    setLastRoom(room);
    setForm({
      name: room.name || '',
      description: room.description || '',
      hourlyRate: room.hourly_rate ?? 300,
      capacity: room.capacity ?? 5,
      gear: (room.gear || []).join('\n'),
      color: room.color || COLORS[0],
      active: room.active ?? true,
      sortOrder: room.sort_order ?? 0,
    });
    setError('');
  }

  if (!form) return null;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const payload = {
      ...form,
      hourlyRate: Number(form.hourlyRate),
      capacity: Number(form.capacity),
      gear: form.gear.split('\n').map((g) => g.trim()).filter(Boolean),
    };
    try {
      if (isNew) await adminApi.createRoom(payload);
      else await adminApi.updateRoom(room.id, payload);
      toast.success(isNew ? `${form.name} added` : 'Room saved');
      onSaved();
      onOpenChange(false);
      setLastRoom(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await adminApi.deleteRoom(room.id);
      toast.success(`${room.name} deleted`);
      onSaved();
      setConfirmDelete(false);
      onOpenChange(false);
      setLastRoom(null);
    } catch (err) {
      setConfirmDelete(false);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          onOpenChange(o);
          if (!o) setLastRoom(null);
        }}
        title={isNew ? 'Add room' : `Edit ${room.name}`}
        wide
      >
        <form onSubmit={save} noValidate>
          <div className="form-grid">
            <Field label="Name">
              {(p) => <input {...p} className="input" value={form.name} onChange={set('name')} maxLength={60} placeholder="Room C" />}
            </Field>
            <div className="form-grid-2">
              <Field label="Rate per hour (₱)">
                {(p) => <input {...p} className="input tnum" type="number" inputMode="numeric" min={0} value={form.hourlyRate} onChange={set('hourlyRate')} />}
              </Field>
              <Field label="Fits">
                {(p) => <input {...p} className="input tnum" type="number" inputMode="numeric" min={1} value={form.capacity} onChange={set('capacity')} />}
              </Field>
            </div>
            <Field label="Description" optional className="span-2">
              {(p) => <textarea {...p} className="textarea" rows={2} value={form.description} onChange={set('description')} maxLength={400} />}
            </Field>
            <Field label="Gear" optional hint="One item per line." className="span-2">
              {(p) => <textarea {...p} className="textarea" rows={5} value={form.gear} onChange={set('gear')} placeholder={'5-piece drum kit\nGuitar amp\nBass amp'} />}
            </Field>
            <div className="field">
              <span className="field-label" id="color-label">
                Color on the schedule
              </span>
              <div className="swatches" role="radiogroup" aria-labelledby="color-label">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={form.color.toLowerCase() === c.toLowerCase()}
                    aria-label={c}
                    className="swatch"
                    style={{ background: c }}
                    onClick={() => setForm((f) => ({ ...f, color: c }))}
                  />
                ))}
              </div>
            </div>
            <div className="field">
              <span className="field-label">Website</span>
              <label className="switch-row">
                <Switch checked={form.active} onChange={(v) => setForm((f) => ({ ...f, active: v }))} label="Show on website" />
                <span>{form.active ? 'Shown, bands can book it' : 'Hidden, bands can’t book it'}</span>
              </label>
            </div>
          </div>

          {error && (
            <div className="notice notice-bad" style={{ marginTop: 16 }} role="alert">
              {error}
            </div>
          )}

          <div className="dialog-actions">
            {!isNew && (
              <button type="button" className="btn btn-ghost a-danger-text" onClick={() => setConfirmDelete(true)} style={{ marginRight: 'auto' }}>
                Delete room
              </button>
            )}
            <button type="button" className="btn btn-outline" onClick={() => onOpenChange(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-dark" disabled={busy}>
              {busy ? 'Saving…' : isNew ? 'Add room' : 'Save room'}
            </button>
          </div>
        </form>
      </Dialog>
      {!isNew && (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={`Delete ${room.name}?`}
          description="Rooms with past bookings can’t be deleted, so their records stay complete. Hide the room from the website instead."
          confirmLabel="Delete room"
          danger
          busy={busy}
          onConfirm={remove}
        />
      )}
    </>
  );
}
