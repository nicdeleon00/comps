import { useMemo, useState } from 'preact/hooks';
import { useData, post, patch, del, invalidate } from '../lib/api';
import { money, cardApi } from '../lib/format';
import type { CardDetail, Holding, Grades } from '../lib/types';
import { Sheet, Segmented, Field, MoneyInput, toast } from './ui';
import { Thumb } from './Thumb';

const GRADERS = ['PSA', 'BGS', 'CGC', 'SGC'];
const GRADES = ['10', '9.5', '9', '8.5', '8', '7', '6', '5'];
const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'] as const;
const COND_FACTOR: Record<string, number> = { NM: 1, LP: 0.82, MP: 0.62, HP: 0.42, DMG: 0.25 };

function estimate(raw: number | null | undefined, g: Grades | null | undefined, grader: string | null, grade: string | null, cond: string) {
  if (grader && grade) {
    const n = Number(grade);
    const key = n >= 10 ? ({ BGS: 'bgs10', CGC: 'cgc10', SGC: 'sgc10' } as Record<string, keyof Grades>)[grader] ?? 'psa10' : n >= 9.5 ? 'g95' : n >= 9 ? 'g9' : n >= 8 ? 'g8' : 'g7';
    return g?.[key] ?? (n >= 10 ? g?.psa10 : null) ?? raw ?? null;
  }
  return raw != null ? raw * (COND_FACTOR[cond] ?? 1) : null;
}

/** Add or edit a holding. Pass `holding` to edit, or `cardId` to add. */
export function HoldingSheet({ cardId, holding, onClose }: { cardId: string; holding?: Holding; onClose: () => void }) {
  const { data } = useData<CardDetail>(cardApi(cardId));
  const [variant, setVariant] = useState<string | null>(holding?.variant ?? null);
  const [graded, setGraded] = useState<'raw' | 'graded'>(holding?.grader ? 'graded' : 'raw');
  const [grader, setGrader] = useState(holding?.grader ?? 'PSA');
  const [grade, setGrade] = useState(holding?.grade ?? '10');
  const [cond, setCond] = useState(holding?.condition ?? 'NM');
  const [qty, setQty] = useState(holding?.quantity ?? 1);
  const [cost, setCost] = useState(holding?.costBasis != null ? String(holding.costBasis) : '');
  const [date, setDate] = useState(holding?.acquiredAt ?? new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState(holding?.notes ?? '');
  const [saving, setSaving] = useState(false);

  const v = useMemo(() => {
    if (!data) return null;
    return data.variants.find((x) => x.variant === (variant ?? data.variants[0]?.variant)) ?? data.variants[0] ?? null;
  }, [data, variant]);
  const unit = estimate(v?.price, v?.grades, graded === 'graded' ? grader : null, graded === 'graded' ? grade : null, cond);

  const save = async (close: () => void) => {
    setSaving(true);
    const body = {
      cardId, variant: v?.variant ?? variant, grader: graded === 'graded' ? grader : null, grade: graded === 'graded' ? grade : null,
      condition: graded === 'graded' ? 'NM' : cond, quantity: qty, costBasis: cost === '' ? null : Number(cost), acquiredAt: date, notes: notes || null,
    };
    try {
      if (holding) await patch(`/api/collection/${holding.id}`, body);
      else await post('/api/collection', body);
      invalidate('/api/');
      toast(holding ? 'Saved' : `Added ${data?.card.name ?? 'card'}`);
      close();
    } catch (e) {
      toast((e as Error).message);
    } finally { setSaving(false); }
  };

  const remove = async (close: () => void) => {
    if (!holding) return;
    await del(`/api/collection/${holding.id}`);
    invalidate('/api/');
    toast('Removed from collection');
    close();
  };

  return (
    <Sheet title={holding ? 'Edit holding' : 'Add to collection'} onClose={onClose}
      footer={(close) => (
        <>
          {holding && <button class="btn" style={{ color: 'var(--down)', marginRight: 'auto' }} onClick={() => remove(close)}>Remove</button>}
          <button class="btn" onClick={close}>Cancel</button>
          <button class="btn primary" disabled={saving || !data} onClick={() => save(close)}>{holding ? 'Save' : 'Add'}</button>
        </>
      )}>
      <div class="sheet-body">
        {data && (
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 18 }}>
            <Thumb card={data.card} size="md" />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 16 }} class="ellipsis">{data.card.name}</div>
              <div class="muted" style={{ fontSize: 13 }}>{data.card.set}{data.card.number ? ` · #${data.card.number}` : ''}</div>
              <div style={{ marginTop: 6, fontSize: 13 }}>
                <span class="muted">Est. value </span><b class="num">{money(unit)}</b>{qty > 1 && <span class="muted"> × {qty} = <b class="num" style={{ color: 'var(--label)' }}>{money(unit != null ? unit * qty : null)}</b></span>}
              </div>
            </div>
          </div>
        )}
        <div style={{ display: 'grid', gap: 16 }}>
          {data && data.variants.length > 1 && (
            <Field label="Printing">
              <Segmented value={v?.variant ?? ''} options={data.variants.map((x) => ({ value: x.variant, label: x.label || 'Standard' }))} onChange={setVariant} scroll />
            </Field>
          )}
          <Field label="Condition">
            <Segmented value={graded} options={[{ value: 'raw', label: 'Raw' }, { value: 'graded', label: 'Graded' }]} onChange={setGraded} />
          </Field>
          {graded === 'raw' ? (
            <Segmented value={cond} options={CONDITIONS.map((c) => ({ value: c, label: c }))} onChange={setCond} />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Grader">
                <select class="select" style={{ height: 38 }} value={grader} onChange={(e) => setGrader((e.target as HTMLSelectElement).value)}>
                  {GRADERS.map((g) => <option value={g}>{g}</option>)}
                </select>
              </Field>
              <Field label="Grade">
                <select class="select" style={{ height: 38 }} value={grade} onChange={(e) => setGrade((e.target as HTMLSelectElement).value)}>
                  {GRADES.map((g) => <option value={g}>{g}</option>)}
                </select>
              </Field>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 1fr', gap: 12 }}>
            <Field label="Quantity">
              <input class="input num" type="number" min={1} value={qty} onInput={(e) => setQty(Math.max(1, Number((e.target as HTMLInputElement).value) || 1))} />
            </Field>
            <Field label="Paid (each)">
              <MoneyInput value={cost} onValue={setCost} placeholder="0.00" />
            </Field>
            <Field label="Acquired">
              <input class="input" type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
            </Field>
          </div>
          <Field label="Notes">
            <input class="input" value={notes} placeholder="Cert number, where you bought it…" onInput={(e) => setNotes((e.target as HTMLInputElement).value)} />
          </Field>
        </div>
      </div>
    </Sheet>
  );
}
