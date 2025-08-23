// src/pages/AdminCategory.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { db } from "../firebase";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, query, where, onSnapshot, addDoc,
  serverTimestamp, orderBy, writeBatch
} from "firebase/firestore";

export default function AdminCategory() {
  const { categoryId } = useParams();
  const catId = categoryId;
  const nav = useNavigate();

  const [catName, setCatName] = useState("");
  const [loading, setLoading] = useState(true);
  const [services, setServices] = useState([]);

  const [editing, setEditing] = useState(null);
  const [name, setName] = useState("");
  const [durationMin, setDurationMin] = useState("");
  const [price, setPrice] = useState("");
  const [discount, setDiscount] = useState("");
  const [groupName, setGroupName] = useState(""); // naziv grupe (upiši ili izaberi)
  const [saving, setSaving] = useState(false);

  // Reorder state (shared)
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);

  // Mobile: tap-to-move
  const [isMobile, setIsMobile] = useState(false);
  const [selectedId, setSelectedId] = useState(null); // prvi tap (koji se premešta)

  // Auto-scroll target (za stare delove koji ga koriste)
  const listRef = useRef(null);

  const finalPrice = useMemo(() => {
    const p = Number(price) || 0;
    const d = Number(discount) || 0;
    return Math.max(0, Math.round(p * (1 - d / 100)));
  }, [price, discount]);

  // Debounce utility
  const debounce = (fn, ms) => {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };
  const debouncedSetOverId = useMemo(() => debounce(setOverId, 50), []);

  // Detect mobile (touch)
  useEffect(() => {
    const touch = typeof window !== "undefined" && (navigator.maxTouchPoints > 0 || "ontouchstart" in window);
    setIsMobile(!!touch);
  }, []);

  // Učitavanje
  useEffect(() => {
    if (!catId) return;

    let off = () => {};
    if (catId === "discounts") {
      (async () => {
        try {
          const snap = await getDoc(doc(db, "meta", "discounts"));
          const t = snap.exists() ? (snap.data().title || "Na popustu") : "Na popustu";
          setCatName(t);
        } catch {
          setCatName("Na popustu");
        }
        setLoading(false);
      })();

      off = onSnapshot(
        query(
          collection(db, "services"),
          where("discountPercent", ">", 0),
          orderBy("discountPercent", "asc"),
          orderBy("name", "asc")
        ),
        (s) => setServices(s.docs.map((d) => ({ id: d.id, ...d.data() })))
      );
    } else {
      (async () => {
        const snap = await getDoc(doc(db, "categories", catId));
        if (snap.exists()) setCatName(snap.data().name || "");
        setLoading(false);

        off = onSnapshot(
          query(
            collection(db, "services"),
            where("categoryId", "==", catId),
            orderBy("order", "asc")
          ),
          (s) => setServices(s.docs.map((d) => ({ id: d.id, ...d.data() })))
        );
      })();
    }

    return () => off();
  }, [catId]);

  // Helpers
  const canReorder = catId !== "discounts";
  // Samo za prikaz: u "discounts" sortiraj po groupName da bi se lepo grupisalo
const renderServices = useMemo(() => {
  if (catId !== "discounts") return services;

  const byGroup = services.slice().sort((a, b) => {
    const ga = (a.groupName || "").trim().toLocaleLowerCase("sr");
    const gb = (b.groupName || "").trim().toLocaleLowerCase("sr");
    if (ga !== gb) return ga.localeCompare(gb, "sr");
    // unutar grupe pokušaj da zadržiš postojeći 'order' ako postoji, pa po imenu
    const oa = Number(a.order ?? 0);
    const ob = Number(b.order ?? 0);
    if (oa !== ob) return oa - ob;
    return String(a.name || "").localeCompare(String(b.name || ""), "sr");
  });

  return byGroup;
}, [services, catId]);

  const idsFromList = (list) => list.map((x) => x.id);

  // Pomera element "sa" fromIndex na "pre" toIndex;
  // ako želimo "posle targeta", koristićemo toIndex+1, a ova funkcija sama koriguje offset.
  function moveToIndex(listIds, fromIndex, toIndex) {
    if (fromIndex == null || toIndex == null) return listIds;
    const arr = listIds.slice();
    const [item] = arr.splice(fromIndex, 1);
    const adj = fromIndex < toIndex ? toIndex - 1 : toIndex;
    arr.splice(adj, 0, item);
    return arr;
  }

  async function persistOrder(newOrderIds) {
    if (!canReorder) return;
    const batch = writeBatch(db);
    let pos = 1;
    for (const id of newOrderIds) {
      batch.update(doc(db, "services", id), { order: pos++, updatedAt: serverTimestamp() });
    }
    await batch.commit();
  }
  function applyLocalOrder(newIds) {
    setServices((prev) => {
      const byId = new Map(prev.map((x) => [x.id, x]));
      return newIds.map((id, idx) => ({ ...(byId.get(id) || {}), id, order: idx + 1 }));
    });
  }

  // Desktop DnD
  function onDragStart(e, id) {
    if (!canReorder) return e.preventDefault();
    if (isMobile) return; // na telefonu koristimo tap→tap
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
  }
  function onDragOver(e, id) {
    if (!canReorder || isMobile) return;
    e.preventDefault();
    if (id !== overId) debouncedSetOverId(id);
  }
  async function onDrop(e, id) {
    if (!canReorder || isMobile) return;
    e.preventDefault();
    const visibleIds = idsFromList(services);
    const newIds = (function () {
      const fromId = dragId;
      const toId = id;
      if (!fromId || !toId) return visibleIds;
      const fromIdx = visibleIds.indexOf(fromId);
      const toIdx = visibleIds.indexOf(toId);
      if (fromIdx < 0 || toIdx < 0) return visibleIds;
      return moveToIndex(visibleIds, fromIdx, toIdx); // ubaci NA poziciju targeta
    })();
    setDragId(null);
    setOverId(null);
    applyLocalOrder(newIds);
    await persistOrder(newIds);
  }
  function onDragEnd() {
    if (isMobile) return;
    setDragId(null);
    setOverId(null);
  }

  // MOBILE: tap → tap
  function onMobileRowTap(targetId) {
    if (!canReorder || !isMobile) return;

    if (!selectedId) {
      setSelectedId(targetId);
      return;
    }
    if (selectedId === targetId) {
      setSelectedId(null);
      return;
    }

    const ids = idsFromList(services);
    const fromIdx = ids.indexOf(selectedId);
    const targetIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || targetIdx === -1) {
      setSelectedId(null);
      return;
    }

    const insertIndex = targetIdx; // POSLE targeta (moveToIndex koriguje)
    const newIds = moveToIndex(ids, fromIdx, insertIndex);
    applyLocalOrder(newIds);
    persistOrder(newIds).catch(console.error);
    setSelectedId(null);
  }

  // Form helpers
  const resetForm = () => {
    setEditing(null);
    setName("");
    setDurationMin("");
    setPrice("");
    setDiscount("");
    setGroupName(""); // reset grupe
  };

  const saveCategoryName = async () => {
    const n = catName.trim();
    if (!n) return;

    if (catId === "discounts") {
      try {
        await updateDoc(doc(db, "meta", "discounts"), { title: n, updatedAt: serverTimestamp() });
      } catch {
        await setDoc(doc(db, "meta", "discounts"), { title: n, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      }
    } else {
      await updateDoc(doc(db, "categories", catId), { name: n, updatedAt: serverTimestamp() });
    }
    alert("Naziv kategorije sačuvan.");
  };

  const deleteCategory = async () => {
    if (catId === "discounts") return;
    if (services.length) {
      if (!confirm(`Kategorija ima ${services.length} usluga. Obrisaćeš SAMO kategoriju (usluge ostaju). Nastavi?`)) return;
    } else {
      if (!confirm("Obrisati kategoriju?")) return;
    }
    await deleteDoc(doc(db, "categories", catId));
    nav("/admin/katalog");
  };

  const startEdit = (srv) => {
    setEditing(srv.id);
    setName(srv.name || "");
    setDurationMin(String(srv.durationMin || ""));
    setPrice(String(srv.basePrice || ""));
    setDiscount(String(srv.discountPercent ?? srv.discount ?? ""));
    setGroupName(srv.groupName || "");
  };

  const upsertLocalService = (id, payload) => {
    setServices((prev) => {
      const idx = prev.findIndex((x) => x.id === id);
      const nextObj = { ...(prev[idx] || {}), id, ...payload };
      if (idx >= 0) {
        const copy = prev.slice();
        copy[idx] = nextObj;
        return copy;
      }
      return [...prev, nextObj];
    });
  };
  const removeLocalService = (id) => {
    setServices((prev) => prev.filter((x) => x.id !== id));
  };

  // === Grupni helperi ===
  function ensureInGroupBlock(serviceId, targetGroup, position = "end") {
    const norm = (x) => (x || "").trim();
   const ids = renderServices.map(x => x.id);
    const fromIdx = ids.indexOf(serviceId);
    if (fromIdx < 0) return;

    // granice bloka te grupe (bez same usluge)
    let first = -1, last = -1;
    services.forEach((x, i) => {
      if (x.id === serviceId) return;
      if (norm(x.groupName) === norm(targetGroup)) {
        if (first === -1) first = i;
        last = i;
      }
    });

    // gde ubaciti
    let insertIndex;
    if (position === "start") insertIndex = first >= 0 ? first : ids.length;
    else insertIndex = last >= 0 ? last + 1 : ids.length;

    const newIds = moveToIndex(ids, fromIdx, insertIndex);
    applyLocalOrder(newIds);
    persistOrder(newIds).catch(console.error);
  }

  // Jednokratno sređivanje svih grupa
  function compactGroups() {
    const norm = (x) => (x || "").trim();
    const groupOrder = [];
    const buckets = new Map(); // group -> [ids po trenutnom redosledu]

    for (const s of services) {
      const g = norm(s.groupName);
      if (!buckets.has(g)) {
        buckets.set(g, []);
        groupOrder.push(g);
      }
      buckets.get(g).push(s.id);
    }
    const newIds = groupOrder.flatMap((g) => buckets.get(g));
    applyLocalOrder(newIds);
    persistOrder(newIds).catch(console.error);
  }

  const saveService = async (e) => {
    e?.preventDefault?.();
    if (saving) return;

    const prevObj = editing ? services.find((s) => s.id === editing) : null;
    const resolvedCategoryId = editing
      ? (prevObj?.categoryId ?? (catId === "discounts" ? "" : catId))
      : (catId === "discounts" ? "" : catId);

    const payload = {
      categoryId: resolvedCategoryId,
      name: name.trim(),
      durationMin: Number(durationMin) || 0,
      basePrice: Number(price) || 0,
      discountPercent: Number(discount) || 0,
      finalPrice,
      groupName: (groupName || "").trim(),
      updatedAt: serverTimestamp(),
    };
    if (!payload.name) return;

    setSaving(true);
    try {
      if (editing) {
        upsertLocalService(editing, { ...payload, updatedAt: new Date() });
        await updateDoc(doc(db, "services", editing), payload);

        // ako smo promenili grupu – spakuj u blok
        if ((groupName || "") !== (prevObj?.groupName || "")) {
          ensureInGroupBlock(editing, (groupName || "").trim(), "end");
        }

        if (catId === "discounts" && payload.discountPercent <= 0) {
          removeLocalService(editing);
        }
      } else {
        const orderVal = (services?.length || 0) + 1;
        const docRef = await addDoc(collection(db, "services"), {
          ...payload,
          order: orderVal,
          createdAt: serverTimestamp(),
        });
        upsertLocalService(docRef.id, {
          ...payload,
          order: orderVal,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        if ((groupName || "").trim()) {
          ensureInGroupBlock(docRef.id, (groupName || "").trim(), "end");
        }

        if (catId === "discounts" && payload.discountPercent <= 0) {
          removeLocalService(docRef.id);
        }
      }
      resetForm();
    } catch (err) {
      console.error(err);
      alert("Greška pri čuvanju usluge.");
    } finally {
      setSaving(false);
    }
  };

  const removeService = async (id) => {
    if (!confirm("Obrisati uslugu?")) return;
    removeLocalService(id);
    try {
      await deleteDoc(doc(db, "services", id));
      if (editing === id) resetForm();
    } catch (e) {
      console.error(e);
      alert("Greška pri brisanju. Osveži stranicu.");
    }
  };

  // === Helpers za prikaz ===
  function normalizeGroupName(x) {
    const t = (x || "").trim();
    return t || "Ostalo";
  }
  async function changeServiceGroup(db, id, newGroup) {
    try {
      await updateDoc(doc(db, "services", id), { groupName: (newGroup || "").trim(), updatedAt: serverTimestamp() });
    } catch (e) {
      console.error(e);
    }
  }

  // Poznate grupe – samo iz OVE kategorije
  const knownGroups = useMemo(() => {
    const set = new Set();
    services.forEach((s) => {
      const g = (s.groupName || "").trim();
      if (g) set.add(g);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, "sr"));
  }, [services]);

  return (
    <div style={wrap}>
      <div style={panel}>
        <style>{css}</style>

        {/* GORE */}
        <div className="admincat-top">
          <div className="admincat-topbar" style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
            <button className="btn-ghost" style={ghostBtn} onClick={() => nav("/admin/katalog")}>
              ← Nazad
            </button>
            <h2 className="admincat-title" style={title}>{catName || "Kategorija"}</h2>

            {/* Dugme: Sredi grupe */}
            <button
              className="btn-ghost"
              style={{ ...ghostBtn, height: 34, padding: "0 10px", marginLeft: "auto" }}
              onClick={compactGroups}
              type="button"
              title="Grupiši sve usluge po nazivu grupe"
            >
              Sredi grupe
            </button>
          </div>

          <div className="admincat-catrow" style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 8, marginBottom: 14 }}>
            <input
              style={inp}
              value={catName}
              onChange={(e) => setCatName(e.target.value)}
              placeholder="Naziv kategorije"
            />
            <button className="btn-primary" style={btn} onClick={saveCategoryName}>Sačuvaj naziv</button>
            {catId !== "discounts" && (
              <button className="btn-danger" style={dangerBtn} onClick={deleteCategory}>Obriši kategoriju</button>
            )}
          </div>
        </div>

        {/* FORMA */}
        <form onSubmit={saveService} style={formBase} className="admincat-form">
          <input style={inp} placeholder="Naziv usluge" value={name} onChange={(e) => setName(e.target.value)} />
          <input style={inp} type="number" min="0" placeholder="Trajanje (min)" value={durationMin} onChange={(e) => setDurationMin(e.target.value)} />
          <input style={inp} type="number" min="0" placeholder="Cena (RSD)" value={price} onChange={(e) => setPrice(e.target.value)} />
          <input style={inp} type="number" min="0" max="90" placeholder="Popust % (opciono)" value={discount} onChange={(e) => setDiscount(e.target.value)} />

          {/* Grupa: upiši novu ili izaberi postojeću */}
          <input
            style={inp}
            placeholder="Grupa (opciono)"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            list="groupList"
          />
          <datalist id="groupList">
            <option value=""></option>
            {knownGroups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>

          <div className="price-preview">Nova cena: {isNaN(finalPrice) ? 0 : finalPrice} RSD</div>
          <button className="btn-primary" style={btn} type="submit" disabled={saving}>
            {saving ? "Čuvam..." : editing ? "Sačuvaj uslugu" : "Dodaj uslugu"}
          </button>
          {editing && (
            <button className="btn-ghost" style={ghostBtn} type="button" onClick={resetForm}>
              Otkaži
            </button>
          )}
        </form>

        {/* LISTA sa blagim grupnim naslovima */}
        <div ref={listRef} className="admincat-list" style={list}>
          {(() => {
            let lastGroup = null;
            const seq = [];
            renderServices.forEach((s, idx) => {
              const g = normalizeGroupName(s.groupName);
              const isNewGroup = g !== lastGroup;
              if (isNewGroup) {
                lastGroup = g;
                seq.push(
                  <div key={`g-${g}-${idx}`} className="group-title">
                    {g}
                  </div>
                );
              }

              const isEditing = editing === s.id;
              const currentPrice = isEditing ? Number(price) || 0 : s.basePrice;
              const currentDiscount = isEditing ? Number(discount) || 0 : s.discountPercent || 0;
              const currentFinal = isEditing
                ? Math.max(0, Math.round((Number(price) || 0) * (1 - (Number(discount) || 0) / 100)))
                : s.finalPrice;
              const isSelected = isMobile && selectedId === s.id;

              seq.push(
                <div
                  key={s.id}
                  data-id={s.id}
                  className="admincat-row srv-row"
                  style={{
                    ...row,
                    cursor: canReorder ? (isMobile ? "pointer" : "grab") : "default",
                    border: isSelected ? "2px solid #ff5fa2" : row.border,
                    background: isSelected ? "rgba(255,95,162,0.08)" : row.background,
                    transform: isSelected ? "scale(1.01)" : "none",
                  }}
                  draggable={canReorder && !isMobile}
                  onDragStart={(e) => onDragStart(e, s.id)}
                  onDragOver={(e) => onDragOver(e, s.id)}
                  onDrop={async (e) => { await onDrop(e, s.id); }}
                  onDragEnd={() => {}}
                  onClick={async () => {
                    if (!isMobile) return;
                    const previousSel = selectedId;
                    onMobileRowTap(s.id);
                    // Ako je postojao selekt i target pripada drugoj grupi → promeni grupu izabranom
                    if (previousSel && previousSel !== s.id) {
                      const src = services.find((x) => x.id === previousSel);
                      const tgt = services.find((x) => x.id === s.id);
                      const tgtGroup = normalizeGroupName(tgt?.groupName);
                      const srcGroup = normalizeGroupName(src?.groupName);
                      if (tgtGroup !== srcGroup) {
                        changeServiceGroup(db, previousSel, tgt?.groupName || "");
                        setServices((prev) =>
                          prev.map((x) => (x.id === previousSel ? { ...x, groupName: tgt?.groupName || "" } : x))
                        );
                      }
                    }
                  }}
                >
                  <div style={{ userSelect: "none", WebkitUserSelect: "none" }}>
                    <div style={{ fontWeight: 900 }}>{isEditing ? (name || s.name) : s.name}</div>
                    <div style={{ opacity: 0.8, fontSize: 13 }}>
                      {(isEditing ? Number(durationMin) || 0 : s.durationMin) || 0} min · {currentPrice || 0} RSD{" "}
                      {currentDiscount ? `· popust ${currentDiscount}% → ${currentFinal || 0} RSD` : ""}
                      {s.groupName ? ` · grupa: ${s.groupName}` : ""}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 8 }} onClick={(e) => e.stopPropagation()}>
                    <button className="btn-primary" style={smBtn} onClick={() => startEdit(s)}>
                      Izmeni
                    </button>
                    <button className="btn-danger" style={smDel} onClick={() => removeService(s.id)}>
                      Obriši
                    </button>
                  </div>
                </div>
              );
            });
            return seq;
          })()}

          {!services.length && !loading && <div style={{ color: "#fff" }}>Nema usluga.</div>}
        </div>
      </div>
    </div>
  );
}

/* === styles === */
const wrap = { minHeight: "100vh", background: 'url("/slika1.webp") center/cover no-repeat fixed', padding: 24, display: "flex", justifyContent: "center", alignItems: "flex-start" };
const panel = { width: "min(1250px,100%)", background: "rgba(255,255,255,.14)", border: "1px solid rgba(255,255,255,.35)", backdropFilter: "blur(10px)", borderRadius: 28, boxShadow: "0 24px 60px rgba(0,0,0,.25)", padding: "clamp(18px,4vw,28px)" };
const title = { margin: 0, color: "#fff", fontWeight: 900, fontSize: "clamp(18px,3vw,28px)" };
const inp = {
  height: 42,
  borderRadius: 12,
  border: "1px solid #ececec",
  padding: "0 12px",
  background: "#fff",
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
};
const btn = { height: 42, border: "none", borderRadius: 12, background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)", color: "#fff", fontWeight: 800, padding: "0 16px", cursor: "pointer" };
const ghostBtn = { height: 42, borderRadius: 12, border: "1px solid rgba(255,255,255,.7)", background: "transparent", color: "#fff", fontWeight: 800, padding: "0 14px", cursor: "pointer" };
const dangerBtn = { ...btn, background: "#ff5b6e" };
const formBase = {
  display: "grid",
  gap: 8,
  marginBottom: 14,
  alignItems: "center",
};
const list = { display: "grid", gap: 10, paddingBottom: 2 };

const row = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  background: "#fff",
  borderRadius: 14,
  padding: "10px 12px",
  boxShadow: "0 10px 20px rgba(0,0,0,.06)",
  flexWrap: "wrap",
  gap: 8,
  userSelect: "none",
  WebkitUserSelect: "none",
  WebkitTouchCallout: "none",
  transition: "transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease, border 0.1s ease",
  position: "relative",
};
const smBtn = { height: 34, padding: "0 12px", border: "none", borderRadius: 10, background: "#696666ff", cursor: "pointer", fontWeight: 800, color: "#fff" };
const smDel = { ...smBtn, background: "#ffe1e1", color: "#7a1b1b" };

const css = `
  .admincat-top {
    border-radius: 20px;
    border: 1px solid rgba(255,255,255,.25);
    background: rgba(255,255,255,.10);
    backdrop-filter: blur(8px);
    padding: 12px;
    margin-bottom: 14px;
  }
  .admincat-form {
    grid-template-columns:
      minmax(220px, 2fr)
      minmax(120px, 1fr)
      minmax(120px, 1fr)
      minmax(120px, 1fr)
      minmax(160px, auto)
      minmax(150px, auto)
      minmax(120px, auto);
  }
  .admincat-form > * {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }
  .price-preview {
    align-self: center;
    color: #fff;
    font-weight: 800;
    padding: 0 6px;
  }
  @media (max-width: 1100px) {
    .admincat-form {
      grid-template-columns:
        minmax(200px, 1.6fr)
        repeat(3, minmax(120px, 1fr))
        minmax(160px, auto)
        minmax(150px, auto)
        minmax(120px, auto);
    }
  }
  @media (max-width: 900px) {
    .admincat-topbar {
      display: flex !important;
      flex-direction: column;
      align-items: stretch;
      gap: 10px;
      margin-bottom: 12px !important;
    }
    .admincat-topbar .btn-ghost {
      width: 100%;
      height: 44px;
      border-radius: 12px;
      font-weight: 800;
    }
    .admincat-title {
      margin: 0;
      text-align: left;
      font-size: 22px;
      line-height: 1.2;
    }
    .admincat-catrow {
      display: grid !important;
      grid-template-columns: 1fr !important;
      gap: 8px;
      margin-bottom: 12px !important;
    }
    .admincat-catrow input {
      width: 100%;
      height: 44px;
      border-radius: 12px;
    }
    .admincat-catrow .btn-primary,
    .admincat-catrow .btn-danger {
      width: 100%;
      height: 44px;
      border-radius: 12px;
      font-weight: 800;
    }
    .admincat-form {
      grid-template-columns: 1fr !important;
    }
    .admincat-form input,
    .admincat-form button,
    .admincat-form .price-preview {
      width: 100%;
    }
    .admincat-form input {
      height: 44px;
      border-radius: 12px;
    }
    .admincat-form button {
      height: 44px;
      border-radius: 12px;
      font-weight: 800;
    }
    .admincat-row { flex-direction: column; align-items: flex-start; gap: 10px; }
    .admincat-row > div:last-child { display: flex; flex-direction: column; gap: 8px; width: 100%; }
    .admincat-row button { width: 100%; height: 42px; border-radius: 12px; font-weight: 800; }
  }
  .group-title { color: #fff; font-weight: 900; margin: 6px 0 8px; }
`;
