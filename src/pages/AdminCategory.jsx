import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { db } from "../firebase";
import {
  doc, getDoc, updateDoc, deleteDoc,
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

  const finalPrice = useMemo(() => {
    const p = Number(price) || 0;
    const d = Number(discount) || 0;
    return Math.max(0, Math.round(p * (1 - d / 100)));
  }, [price, discount]);

  useEffect(() => {
    if (!catId) return;

    let off = () => {};
    if (catId === "discounts") {
      setCatName("Na popustu");
      setLoading(false);
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
    if (catId === "discounts") return;
    const n = catName.trim();
    if (!n) return;
    await updateDoc(doc(db, "categories", catId), { name: n, updatedAt: serverTimestamp() });
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

  const saveService = async (e) => {
    e?.preventDefault?.();
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

    if (editing) {
      await updateDoc(doc(db, "services", editing), payload);
    } else {
      await addDoc(collection(db, "services"), {
        ...payload,
        order: (services?.length || 0) + 1,
        createdAt: serverTimestamp(),
      });
    }
    resetForm();
  };

  const removeService = async (id) => {
    if (!confirm("Obrisati uslugu?")) return;
    await deleteDoc(doc(db, "services", id));
    if (editing === id) resetForm();
  };

  return (
    <div style={wrap}>
      <div style={panel}>
        <style>{css}</style>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
          <button style={ghostBtn} onClick={() => nav("/admin/katalog")}>← Nazad</button>
          <h2 style={title}>{catName || "Kategorija"}</h2>
        </div>

        {catId !== "discounts" && (
          <div className="admincat-catrow">
            <input style={inp} value={catName} onChange={e => setCatName(e.target.value)} placeholder="Naziv kategorije" />
            <button style={btn} onClick={saveCategoryName}>Sačuvaj naziv</button>
            <button style={dangerBtn} onClick={deleteCategory}>Obriši kategoriju</button>
          </div>
        )}

        <form onSubmit={saveService} style={form} className="admincat-form">
          <input style={inp} placeholder="Naziv usluge" value={name} onChange={e => setName(e.target.value)} />
          <input style={inp} type="number" min="0" placeholder="Trajanje (min)" value={durationMin} onChange={e => setDurationMin(e.target.value)} />
          <input style={inp} type="number" min="0" placeholder="Cena (RSD)" value={price} onChange={e => setPrice(e.target.value)} />
          <input style={inp} type="number" min="0" max="90" placeholder="Popust % (opciono)" value={discount} onChange={e => setDiscount(e.target.value)} />
          <div style={{ alignSelf: "center", color: "#fff", fontWeight: 800 }}>Nova cena: {isNaN(finalPrice) ? 0 : finalPrice} RSD</div>
          <button style={btn} type="submit">{editing ? "Sačuvaj uslugu" : "Dodaj uslugu"}</button>
          {editing && <button style={ghostBtn} type="button" onClick={resetForm}>Otkaži</button>}
        </form>

        <div style={list}>
          {services.map(s => {
            const isEditing = editing === s.id;
            const currentPrice = isEditing ? Number(price) || 0 : s.basePrice;
            const currentDiscount = isEditing ? Number(discount) || 0 : s.discountPercent || 0;
            const currentFinal = isEditing
              ? Math.max(0, Math.round(currentPrice * (1 - currentDiscount / 100)))
              : s.finalPrice;

            return (
              <div key={s.id} style={row} className="admincat-row">
                <div>
                  <div style={{ fontWeight: 900 }}>{s.name}</div>
                  <div style={{ opacity: .8, fontSize: 13 }}>
                    {s.durationMin} min · {currentPrice} RSD{" "}
                    {currentDiscount ? `· popust ${currentDiscount}% → ${currentFinal} RSD` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={smBtn} onClick={() => startEdit(s)}>Izmeni</button>
                  <button style={smDel} onClick={() => removeService(s.id)}>Obriši</button>
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
const inp = { height: 42, borderRadius: 12, border: "1px solid #ececec", padding: "0 12px", background: "#fff" };
const btn = { height: 42, border: "none", borderRadius: 12, background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)", color: "#fff", fontWeight: 800, padding: "0 16px", cursor: "pointer" };
const ghostBtn = { height: 42, borderRadius: 12, border: "1px solid rgba(255,255,255,.7)", background: "transparent", color: "#fff", fontWeight: 800, padding: "0 14px", cursor: "pointer" };
const dangerBtn = { ...btn, background: "#ff5b6e" };
const form = { display: "grid", gridTemplateColumns: "2fr 140px 140px 160px auto auto auto", gap: 8, marginBottom: 14 };
const list = { display: "grid", gap: 10 };
const row = { display: "flex", justifyContent: "space-between", alignItems: "center", background: "#fff", borderRadius: 14, padding: "10px 12px", boxShadow: "0 10px 20px rgba(0,0,0,.06)", flexWrap: "wrap", gap: 8 };
const smBtn = { height: 34, padding: "0 12px", border: "none", borderRadius: 10, background: "#efefef", cursor: "pointer", fontWeight: 800 };
const smDel = { ...smBtn, background: "#ffe1e1", color: "#7a1b1b" };

/* dodatni CSS za mobile */
const css = `
@media (max-width: 900px) {
  .admincat-catrow {
    display: grid;
    grid-template-columns: 1fr;
    gap: 8px;
    margin-bottom: 14px;
  }
  .admincat-form {
    grid-template-columns: 1fr;
  }
  .admincat-form input,
  .admincat-form button,
  .admincat-form div {
    width: 100%;
  }
  .admincat-row {
    flex-direction: column;
    align-items: flex-start;
  }
  .admincat-row > div:last-child {
    display: flex;
    gap: 8px;
    width: 100%;
    flex-wrap: wrap;
    justify-content: flex-start;
  }
}
`;
