// src/pages/AdminCategory.jsx
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { db } from "../firebase";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, query, where, onSnapshot, addDoc,
  serverTimestamp, orderBy
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
  const [saving, setSaving] = useState(false);

  const finalPrice = useMemo(() => {
    const p = Number(price) || 0;
    const d = Number(discount) || 0;
    return Math.max(0, Math.round(p * (1 - d / 100)));
  }, [price, discount]);

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
          orderBy("name", "asc")
        ),
        (s) => {
          setServices(s.docs.map((d) => ({ id: d.id, ...d.data() })));
        }
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
          (s) => {
            const arr = s.docs.map((d) => ({ id: d.id, ...d.data() }));
            setServices(arr);
          }
        );
      })();
    }

    return () => off();
  }, [catId]);

  const resetForm = () => {
    setEditing(null);
    setName("");
    setDurationMin("");
    setPrice("");
    setDiscount("");
  };

  const saveCategoryName = async () => {
    const n = catName.trim();
    if (!n) return;

    if (catId === "discounts") {
      try {
        await updateDoc(doc(db, "meta", "discounts"), {
          title: n,
          updatedAt: serverTimestamp(),
        });
      } catch {
        await setDoc(doc(db, "meta", "discounts"), {
          title: n,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } else {
      await updateDoc(doc(db, "categories", catId), {
        name: n,
        updatedAt: serverTimestamp(),
      });
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
  };

  // 👉 OPTIMISTIČKI upsert u lokalni state (odmah prikaže izmenu)
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

  // 👉 OPTIMISTIČKO uklanjanje iz lokalnog state-a
  const removeLocalService = (id) => {
    setServices((prev) => prev.filter((x) => x.id !== id));
  };

  const saveService = async (e) => {
    e?.preventDefault?.();
    if (saving) return;

    const payload = {
      categoryId: catId === "discounts" ? "" : catId,
      name: name.trim(),
      durationMin: Number(durationMin) || 0,
      basePrice: Number(price) || 0,
      discountPercent: Number(discount) || 0,
      finalPrice,
      updatedAt: serverTimestamp(),
    };
    if (!payload.name) return;

    setSaving(true);
    try {
      if (editing) {
        // Optimistički: prikaži odmah u listi
        upsertLocalService(editing, {
          ...payload,
          updatedAt: new Date(), // samo za UI
        });

        await updateDoc(doc(db, "services", editing), payload);

        // Ako smo u "discounts" i popust je postao 0, skini iz liste odmah
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

        // Optimistički dodaj u listu (sa privremenim order-om)
        upsertLocalService(docRef.id, {
          ...payload,
          order: orderVal,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        // Ako smo u "discounts" modu i novi popust je 0, ne prikazuj ga (pošto query filtrira > 0)
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
    // Optimistički ukloni
    removeLocalService(id);
    try {
      await deleteDoc(doc(db, "services", id));
      if (editing === id) resetForm();
    } catch (e) {
      console.error(e);
      alert("Greška pri brisanju. Osveži stranicu.");
    }
  };

  return (
    <div style={wrap}>
      <div style={panel}>
        <style>{css}</style>

        {/* GORNJI BLOK – lep card + mobile kolona */}
        <div className="admincat-top">
          <div className="admincat-topbar" style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
            <button className="btn-ghost" style={ghostBtn} onClick={() => nav("/admin/katalog")}>← Nazad</button>
            <h2 className="admincat-title" style={title}>{catName || "Kategorija"}</h2>
          </div>

          {/* EDIT NAZIVA */}
          <div className="admincat-catrow" style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 8, marginBottom: 14 }}>
            <input
              style={inp}
              value={catName}
              onChange={e => setCatName(e.target.value)}
              placeholder="Naziv kategorije"
            />
            <button className="btn-primary" style={btn} onClick={saveCategoryName}>Sačuvaj naziv</button>
            {catId !== "discounts" && (
              <button className="btn-danger" style={dangerBtn} onClick={deleteCategory}>Obriši kategoriju</button>
            )}
          </div>
        </div>

        {/* FORMA ZA USLUGU */}
        <form onSubmit={saveService} style={formBase} className="admincat-form">
          <input
            style={inp}
            placeholder="Naziv usluge"
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <input
            style={inp}
            type="number" min="0"
            placeholder="Trajanje (min)"
            value={durationMin}
            onChange={e => setDurationMin(e.target.value)}
          />
          <input
            style={inp}
            type="number" min="0"
            placeholder="Cena (RSD)"
            value={price}
            onChange={e => setPrice(e.target.value)}
          />
          <input
            style={inp}
            type="number" min="0" max="90"
            placeholder="Popust % (opciono)"
            value={discount}
            onChange={e => setDiscount(e.target.value)}
          />
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

        <div style={list}>
          {services.map(s => {
            const isEditing = editing === s.id;
            const currentPrice = isEditing ? Number(price) || 0 : s.basePrice;
            const currentDiscount = isEditing ? Number(discount) || 0 : s.discountPercent || 0;
            const currentFinal = isEditing
              ? Math.max(0, Math.round((Number(price) || 0) * (1 - (Number(discount) || 0) / 100)))
              : s.finalPrice;

            return (
              <div key={s.id} style={row} className="admincat-row">
                <div>
                  <div style={{ fontWeight: 900 }}>{isEditing ? (name || s.name) : s.name}</div>
                  <div style={{ opacity: .8, fontSize: 13 }}>
                    {(isEditing ? Number(durationMin) || 0 : s.durationMin) || 0} min · {currentPrice || 0} RSD{" "}
                    {currentDiscount ? `· popust ${currentDiscount}% → ${currentFinal || 0} RSD` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn-primary" style={smBtn} onClick={() => startEdit(s)}>Izmeni</button>
                  <button className="btn-danger" style={smDel} onClick={() => removeService(s.id)}>Obriši</button>
                </div>
              </div>
            );
          })}

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

/* baza forme (kolone definišemo u CSS-u da bi media query radio) */
const formBase = {
  display: "grid",
  gap: 8,
  marginBottom: 14,
  alignItems: "center",
};

const list = { display: "grid", gap: 10 };
const row = { display: "flex", justifyContent: "space-between", alignItems: "center", background: "#fff", borderRadius: 14, padding: "10px 12px", boxShadow: "0 10px 20px rgba(0,0,0,.06)", flexWrap: "wrap", gap: 8 };
const smBtn = { height: 34, padding: "0 12px", border: "none", borderRadius: 10, background: "#696666ff", cursor: "pointer", fontWeight: 800, color:"#fff" };
const smDel = { ...smBtn, background: "#ffe1e1", color: "#7a1b1b" };

/* dodatni CSS */
const css = `
/* lep "card" header na svim ekranima */
.admincat-top {
  border-radius: 20px;
  border: 1px solid rgba(255,255,255,.25);
  background: rgba(255,255,255,.10);
  backdrop-filter: blur(8px);
  padding: 12px;
  margin-bottom: 14px;
}

/* RASPORED FORME — desktop prvo */
.admincat-form {
  grid-template-columns:
    minmax(220px, 2fr)    /* Naziv usluge */
    minmax(120px, 1fr)    /* Trajanje */
    minmax(120px, 1fr)    /* Cena */
    minmax(120px, 1fr)    /* Popust */
    minmax(160px, auto)   /* Nova cena */
    minmax(150px, auto)   /* Dodaj/Sačuvaj */
    minmax(120px, auto);  /* Otkaži (ako je edit) */
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

/* --- TABLET --- */
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

/* --- MOBILE --- */
@media (max-width: 900px) {
  /* top bar: Nazad + naslov -> kolona */
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

  /* red sa inputom za naziv + dugmad -> kolona, full width */
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

  /* FORMA ispod – jedna kolona, NIŠTA ne izlazi iz širine */
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

  /* Redovi u listi: kolona + full-width dugmad */
  .admincat-row { flex-direction: column; align-items: flex-start; gap: 10px; }
  .admincat-row > div:last-child { display: flex; flex-direction: column; gap: 8px; width: 100%; }
  .admincat-row button { width: 100%; height: 42px; border-radius: 12px; font-weight: 800; }
}

/* (opciono) sticky top na mobilnom – otkomentariši ako želiš da bude zalepljen
@media (max-width: 900px) {
  .admincat-top { position: sticky; top: 12px; z-index: 5; }
}
*/
`;
