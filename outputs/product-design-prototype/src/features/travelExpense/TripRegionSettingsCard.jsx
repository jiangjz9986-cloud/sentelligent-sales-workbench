import {
  CircleAlert,
  LoaderCircle,
  MapPin,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  addResponsibleCity,
  buildResponsibleRegionPayload,
  createResponsibleRegionDraft,
  removeResponsibleCity,
  removeResponsibleRegionDateOverride,
  responsibleRegionWeekDates,
  setResponsibleRegionWeekDefault,
  upsertResponsibleRegionDateOverride,
} from "./responsibleRegionModel.js";
import "./tripRegionSettingsCard.css";

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function userMessage(error, fallback) {
  if (error?.status === 409 || error?.code === "VERSION_CONFLICT") {
    return "区域设置已在其他窗口更新，请重新加载后再编辑。";
  }
  if (error?.status === 428) return "区域设置版本已过期，请重新加载后再保存。";
  return error instanceof Error ? error.message : fallback;
}

export function TripRegionSettingsCard({
  open,
  profile,
  pending = false,
  onClose,
  onSave,
}) {
  const [draft, setDraft] = useState(null);
  const [cityInput, setCityInput] = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open || !profile) return;
    try {
      setDraft(createResponsibleRegionDraft(profile));
      setCityInput("");
      setError("");
    } catch (loadError) {
      setDraft(null);
      setError(userMessage(loadError, "区域设置读取失败。"));
    }
  }, [open, profile]);

  useEffect(() => {
    if (!open) return undefined;
    function handleKeyDown(event) {
      if (event.key === "Escape" && !pending) onClose?.();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open, pending]);

  useEffect(() => {
    if (open && draft) inputRef.current?.focus();
  }, [draft, open]);

  const dates = useMemo(() => (
    draft ? responsibleRegionWeekDates(draft.weekStart) : []
  ), [draft]);

  if (!open) return null;

  function addCity() {
    if (!draft) return;
    try {
      const result = addResponsibleCity(draft.cities, cityInput);
      setDraft((current) => ({
        ...current,
        cities: result.cities,
        defaultCity: current.defaultCity ?? result.city,
      }));
      setCityInput("");
      setError("");
    } catch (addError) {
      setError(userMessage(addError, "城市添加失败。"));
    }
  }

  function removeCity(city) {
    try {
      setDraft((current) => removeResponsibleCity(current, city));
      setError("");
    } catch (removeError) {
      setError(userMessage(removeError, "城市删除失败。"));
    }
  }

  function updateDate(date, city) {
    try {
      setDraft((current) => city
        ? upsertResponsibleRegionDateOverride(current, { date, city })
        : removeResponsibleRegionDateOverride(current, date));
      setError("");
    } catch (updateError) {
      setError(userMessage(updateError, "日期区域更新失败。"));
    }
  }

  async function save() {
    if (!draft || pending) return;
    setError("");
    try {
      const payload = buildResponsibleRegionPayload(draft);
      await onSave?.({ ...payload, version: draft.version });
    } catch (saveError) {
      setError(userMessage(saveError, "区域设置保存失败，请稍后重试。"));
    }
  }

  return (
    <div className="trip-region-settings-layer" data-testid="trip-region-settings-layer">
      <section
        className="trip-region-settings-card"
        role="dialog"
        aria-modal="false"
        aria-labelledby="trip-region-settings-title"
      >
        <header>
          <div><span><MapPin size={18} aria-hidden="true" /></span><div><strong id="trip-region-settings-title">本周出差区域</strong><small>{profile?.weekStart}—{profile?.weekEnd}</small></div></div>
          <button type="button" aria-label="关闭区域设置" disabled={pending} onClick={() => onClose?.()}><X size={19} /></button>
        </header>

        {draft ? (
          <div className="trip-region-settings-body">
            <section className="trip-region-city-section">
              <div><strong>我负责的城市</strong><p>可添加多个城市；第一个城市自动成为本周默认。</p></div>
              <div className="trip-region-city-input">
                <input
                  ref={inputRef}
                  value={cityInput}
                  placeholder="例如：济宁"
                  aria-label="新增负责城市"
                  onChange={(event) => setCityInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addCity();
                    }
                  }}
                />
                <button type="button" onClick={addCity} disabled={!cityInput.trim() || pending}><Plus size={16} />添加</button>
              </div>
              <div className="trip-region-city-chips" aria-label="已添加的负责城市">
                {draft.cities.map((city) => (
                  <span key={city} data-default={draft.defaultCity === city || undefined}>
                    {city}{draft.defaultCity === city ? <small>默认</small> : null}
                    <button type="button" aria-label={`删除${city}`} disabled={pending} onClick={() => removeCity(city)}><Trash2 size={13} /></button>
                  </span>
                ))}
                {draft.cities.length === 0 ? <p><CircleAlert size={15} />请先添加本周负责城市。</p> : null}
              </div>
            </section>

            <label className="trip-region-default-field">
              <span><strong>本周默认城市</strong><small>没有日期覆盖时使用</small></span>
              <select
                value={draft.defaultCity ?? ""}
                disabled={pending || draft.cities.length === 0}
                onChange={(event) => {
                  try {
                    setDraft((current) => setResponsibleRegionWeekDefault(current, event.target.value || null));
                    setError("");
                  } catch (defaultError) {
                    setError(userMessage(defaultError, "默认城市更新失败。"));
                  }
                }}
              >
                <option value="">未设置，录入前询问</option>
                {draft.cities.map((city) => <option key={city} value={city}>{city}</option>)}
              </select>
            </label>

            <section className="trip-region-date-grid" aria-label="周一至周日区域覆盖">
              <header><strong>逐日覆盖</strong><span>仅修改不在默认城市的日期</span></header>
              {dates.map((date, index) => {
                const override = draft.dateOverrides.find((item) => item.date === date);
                return (
                  <label key={date}>
                    <span><strong>{WEEKDAY_LABELS[index]}</strong><small>{date.slice(5)}</small></span>
                    <select value={override?.city ?? ""} disabled={pending || draft.cities.length === 0} onChange={(event) => updateDate(date, event.target.value)}>
                      <option value="">跟随默认{draft.defaultCity ? `（${draft.defaultCity}）` : ""}</option>
                      {draft.cities.map((city) => <option key={city} value={city}>{city}</option>)}
                    </select>
                  </label>
                );
              })}
            </section>
          </div>
        ) : null}

        {error ? <p className="trip-region-settings-error" role="alert"><CircleAlert size={16} />{error}</p> : null}
        <footer>
          <span>保存后，小小会按发生日期自动使用对应区域；没有匹配区域时会先询问。</span>
          <div><button type="button" disabled={pending} onClick={() => onClose?.()}>取消</button><button className="primary" type="button" disabled={pending || !draft} onClick={() => void save()}>{pending ? <LoaderCircle className="state-spinner" size={16} /> : <Save size={16} />}{pending ? "保存中" : "保存区域"}</button></div>
        </footer>
      </section>
    </div>
  );
}
