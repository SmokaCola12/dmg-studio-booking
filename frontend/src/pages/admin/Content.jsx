import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, ImagePlus, Plus, Trash2, X } from 'lucide-react';
import { adminApi } from '../../lib/api.js';
import { site } from '../../config/site.js';
import { ConfirmDialog, Field } from '../../components/ui.jsx';
import { LoadError, PageHead, useLoader } from './admin-shared.jsx';

const MAX_PHOTOS = 24;
const MAX_SOCIALS = 6;
const MAX_SIDE = 1600;

const EMPTY_FORM = { address: '', landmark: '', mapsQuery: '', phone: '', email: '', messenger: '', socials: [] };

/** Saved overrides only. A blank field means "use the default", which is shown as the placeholder. */
function toForm(c = {}) {
  return {
    address: (c.address || []).join('\n'),
    landmark: c.landmark || '',
    mapsQuery: c.mapsQuery || '',
    phone: c.phone || '',
    email: c.email || '',
    messenger: c.messenger || '',
    socials: (c.socials || []).map((s) => ({ label: s.label, href: s.href })),
  };
}

const blankToNull = (v) => (v.trim() === '' ? null : v.trim());

function toPayload(f) {
  const lines = f.address.split('\n').map((l) => l.trim()).filter(Boolean);
  const socials = f.socials.map((s) => ({ label: s.label.trim(), href: s.href.trim() })).filter((s) => s.label || s.href);
  return {
    address: lines.length ? lines : null,
    landmark: blankToNull(f.landmark),
    mapsQuery: blankToNull(f.mapsQuery),
    phone: blankToNull(f.phone),
    email: blankToNull(f.email),
    messenger: blankToNull(f.messenger),
    socials: socials.length ? socials : null,
  };
}

/** Resizes to at most MAX_SIDE on the long side and re-encodes as JPEG (also drops EXIF/location data). */
async function prepareImage(file) {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not an image.`);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name} couldn’t be read. Use a JPG, PNG or WebP photo.`);
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // PNGs with transparency would turn black as JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new Error(`${file.name} couldn’t be prepared. Try another photo.`);
  return blob;
}

export default function Content() {
  const loaded = useLoader(() => adminApi.content(), []);
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(null);
  const [gallery, setGallery] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});

  useEffect(() => {
    if (loaded.data) {
      const f = toForm(loaded.data.contact);
      setForm(f);
      setSaved(f);
      setGallery(loaded.data.gallery || []);
    }
  }, [loaded.data]);

  if (loaded.error && !loaded.data) return <LoadError error={loaded.error} onRetry={loaded.reload} />;
  if (!form) {
    return (
      <div className="a-page">
        <PageHead title="Studio page" />
        <div className="skeleton" style={{ height: 320 }} />
      </div>
    );
  }

  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const text = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setSocial = (i, k, v) =>
    setForm((f) => ({ ...f, socials: f.socials.map((s, j) => (j === i ? { ...s, [k]: v } : s)) }));
  const err = (k) => fieldErrors[k];

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setFieldErrors({});
    try {
      const r = await adminApi.saveContact(toPayload(form));
      const f = toForm(r.contact);
      setForm(f);
      setSaved(f);
      toast.success('Contact details saved');
    } catch (e2) {
      setError(e2.message);
      setFieldErrors(e2.fields || {});
      toast.error(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="a-page settings">
      <PageHead
        title="Studio page"
        sub="The contact details and photos on the website. Leave a field blank to use the standard text."
      />

      <form onSubmit={save} noValidate>
        <section className="set-section" aria-labelledby="ct-title">
          <h2 id="ct-title" className="a-h2">
            Contact & location
          </h2>
          <div className="form-grid">
            <Field
              label="Address"
              hint="One line each, up to 3. The last line shows on the booking card."
              error={err('address')}
              className="span-2"
            >
              {(p) => (
                <textarea
                  {...p}
                  className="textarea"
                  rows={3}
                  value={form.address}
                  onChange={text('address')}
                  placeholder={site.address.join('\n')}
                />
              )}
            </Field>
            <Field label="Landmark" hint="How to find the door." error={err('landmark')} className="span-2">
              {(p) => <input {...p} className="input" maxLength={200} value={form.landmark} onChange={text('landmark')} placeholder={site.landmark} />}
            </Field>
            <Field
              label="Map search"
              hint="An address or place name, as you would type it in Google Maps."
              error={err('mapsQuery')}
              className="span-2"
            >
              {(p) => <input {...p} className="input" maxLength={200} value={form.mapsQuery} onChange={text('mapsQuery')} placeholder={site.mapsQuery} />}
            </Field>
            <Field label="Phone" error={err('phone')}>
              {(p) => (
                <input {...p} className="input tnum" type="tel" inputMode="tel" maxLength={20} value={form.phone} onChange={text('phone')} placeholder={site.phone} />
              )}
            </Field>
            <Field label="Email" error={err('email')}>
              {(p) => <input {...p} className="input" type="email" inputMode="email" maxLength={120} value={form.email} onChange={text('email')} placeholder={site.email} />}
            </Field>
            <Field label="Messenger link" hint="Starts with https://m.me/ or a Facebook page link." error={err('messenger')} className="span-2">
              {(p) => <input {...p} className="input" type="url" inputMode="url" maxLength={300} value={form.messenger} onChange={text('messenger')} placeholder={site.messenger} />}
            </Field>

            <div className="field span-2">
              <span className="field-label" id="soc-label">
                Social links
              </span>
              {form.socials.length === 0 && (
                <span className="field-hint">Showing the standard link: {site.socials.map((s) => s.label).join(', ')}.</span>
              )}
              <div className="ct-socials" role="group" aria-labelledby="soc-label">
                {form.socials.map((s, i) => (
                  <div key={i} className="ct-social">
                    <input
                      className="input"
                      aria-label={`Social link ${i + 1} name`}
                      placeholder="Name, e.g. Instagram"
                      maxLength={30}
                      value={s.label}
                      onChange={(e) => setSocial(i, 'label', e.target.value)}
                    />
                    <input
                      className="input"
                      type="url"
                      inputMode="url"
                      aria-label={`Social link ${i + 1} address`}
                      placeholder="https://"
                      maxLength={300}
                      value={s.href}
                      onChange={(e) => setSocial(i, 'href', e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost ct-icon-btn"
                      aria-label={`Remove social link ${i + 1}`}
                      onClick={() => setForm((f) => ({ ...f, socials: f.socials.filter((_, j) => j !== i) }))}
                    >
                      <X />
                    </button>
                  </div>
                ))}
              </div>
              {err('socials') && (
                <span className="field-error" role="alert">
                  {err('socials')}
                </span>
              )}
              {form.socials.length < MAX_SOCIALS && (
                <button
                  type="button"
                  className="btn btn-sm btn-outline ct-add"
                  onClick={() => setForm((f) => ({ ...f, socials: [...f.socials, { label: '', href: '' }] }))}
                >
                  <Plus /> Add a link
                </button>
              )}
            </div>
          </div>
        </section>

        {error && (
          <div className="notice notice-bad" role="alert" style={{ marginTop: 16 }}>
            {error}
          </div>
        )}

        <div className={clsx('save-bar', dirty && 'is-dirty')}>
          <span className="save-bar-text">{dirty ? 'You have unsaved changes.' : 'Contact details are up to date.'}</span>
          <button type="button" className="btn btn-ghost" disabled={!dirty || busy} onClick={() => { setForm(saved); setFieldErrors({}); setError(''); }}>
            Undo changes
          </button>
          <button type="submit" className="btn btn-dark" disabled={!dirty || busy}>
            {busy ? 'Saving…' : 'Save contact details'}
          </button>
        </div>
      </form>

      <GalleryEditor gallery={gallery} setGallery={setGallery} />
    </div>
  );
}

function GalleryEditor({ gallery, setGallery }) {
  const fileRef = useRef(null);
  const [working, setWorking] = useState(false); // upload or reorder in flight
  const [progress, setProgress] = useState('');
  const [toDelete, setToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const full = gallery.length >= MAX_PHOTOS;

  const onFiles = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    setWorking(true);
    let added = 0;
    let count = gallery.length;
    for (let i = 0; i < files.length; i++) {
      if (count >= MAX_PHOTOS) {
        toast.error(`The gallery holds ${MAX_PHOTOS} photos. Remove one to add more.`);
        break;
      }
      setProgress(files.length > 1 ? `Uploading ${i + 1} of ${files.length}…` : 'Uploading…');
      try {
        const blob = await prepareImage(files[i]);
        const { photo } = await adminApi.uploadPhoto(blob, '');
        setGallery((g) => [...g, photo]);
        count++;
        added++;
      } catch (err) {
        toast.error(err.message);
      }
    }
    setProgress('');
    setWorking(false);
    if (added) toast.success(added === 1 ? 'Photo added' : `${added} photos added`);
  };

  const move = async (index, dir) => {
    const ids = gallery.map((p) => p.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    setWorking(true);
    try {
      const r = await adminApi.reorderGallery(ids);
      setGallery(r.gallery);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setWorking(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await adminApi.deletePhoto(toDelete.id);
      setGallery((g) => g.filter((p) => p.id !== toDelete.id));
      toast.success('Photo removed');
      setToDelete(null);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setDeleting(false);
    }
  };

  const saveAlt = async (photo, alt) => {
    try {
      const r = await adminApi.updatePhoto(photo.id, alt);
      setGallery((g) => g.map((p) => (p.id === photo.id ? { ...p, ...r.photo } : p)));
      toast.success('Description saved');
      return true;
    } catch (err) {
      toast.error(err.message);
      return false;
    }
  };

  return (
    <section className="set-section" aria-labelledby="gal-title">
      <div className="set-head">
        <h2 id="gal-title" className="a-h2">
          Gallery <span className="muted tnum">{gallery.length}/{MAX_PHOTOS}</span>
        </h2>
        <button type="button" className="btn btn-dark btn-sm" disabled={working || full} onClick={() => fileRef.current?.click()}>
          <ImagePlus /> {working && progress ? progress : 'Add photos'}
        </button>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={onFiles} />
      </div>
      <p className="a-hint ct-gal-hint">
        Photos show under “Inside the studio” on the home page, in this order. Changes here go live right away. Big photos are shrunk before they upload.
      </p>

      {gallery.length === 0 ? (
        <div className="a-empty">
          No photos yet. The website shows “Photo to come” boxes until you add some.
        </div>
      ) : (
        <ul className="ct-gallery">
          {gallery.map((p, i) => (
            <PhotoCard
              key={p.id}
              photo={p}
              index={i}
              last={i === gallery.length - 1}
              disabled={working}
              onMove={move}
              onDelete={() => setToDelete(p)}
              onSaveAlt={saveAlt}
            />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && !deleting && setToDelete(null)}
        title="Remove this photo?"
        description="It disappears from the website. This can’t be undone."
        confirmLabel={deleting ? 'Removing…' : 'Remove photo'}
        onConfirm={remove}
        busy={deleting}
        danger
      />
    </section>
  );
}

function PhotoCard({ photo, index, last, disabled, onMove, onDelete, onSaveAlt }) {
  const [alt, setAlt] = useState(photo.alt || '');
  useEffect(() => setAlt(photo.alt || ''), [photo.alt]);

  const commit = async () => {
    if (alt.trim() === (photo.alt || '')) return;
    const ok = await onSaveAlt(photo, alt.trim());
    if (!ok) setAlt(photo.alt || '');
  };

  return (
    <li className="ct-photo">
      <img src={photo.src} alt={photo.alt || ''} loading="lazy" className="ct-photo-img" />
      <div className="ct-photo-body">
        <label className="sr-only" htmlFor={`alt-${photo.id}`}>
          Description of photo {index + 1}
        </label>
        <input
          id={`alt-${photo.id}`}
          className="input"
          maxLength={160}
          placeholder="Describe it, e.g. Room A with the drum kit"
          value={alt}
          onChange={(e) => setAlt(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), e.currentTarget.blur())}
        />
        <div className="ct-photo-actions">
          <button type="button" className="btn btn-outline ct-icon-btn" aria-label={`Move photo ${index + 1} earlier`} disabled={disabled || index === 0} onClick={() => onMove(index, -1)}>
            <ArrowUp />
          </button>
          <button type="button" className="btn btn-outline ct-icon-btn" aria-label={`Move photo ${index + 1} later`} disabled={disabled || last} onClick={() => onMove(index, 1)}>
            <ArrowDown />
          </button>
          <button type="button" className="btn btn-outline ct-remove" disabled={disabled} onClick={onDelete}>
            <Trash2 /> Remove
          </button>
        </div>
      </div>
    </li>
  );
}
