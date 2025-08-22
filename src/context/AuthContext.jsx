// src/context/AuthContext.jsx
import { createContext, useContext, useEffect, useState } from "react";
import { db } from "../firebase";
import { doc, setDoc, serverTimestamp, getDoc } from "firebase/firestore";

const AuthContext = createContext(null);
const ADMIN_PHONE = "0665511005"; // normalizovan oblik

function normalizePhone(p) {
  const digits = String(p || "").replace(/\D/g, "");
  return digits.replace(/^381/, "0"); // +381xx -> 0xx
}
const SPECIAL_ROLES = {
  // phone u normalizovanom obliku
  "0000000000": { isAdmin: true, isFinance: false }, // aBeauty: admin bez finansija
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try {
      const raw = localStorage.getItem("abeauty:user");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (user) localStorage.setItem("abeauty:user", JSON.stringify(user));
    else localStorage.removeItem("abeauty:user");
  }, [user]);

  // upis u Firestore + role = admin|client, uz override iz doc-a (isAdmin/isFinance)
  const login = async ({ firstName, lastName, phone }) => {
    const fn = String(firstName || "").trim();
    const ln = String(lastName || "").trim();
    const phoneNorm = normalizePhone(phone);

    // Pročitaj postojeći doc (ako postoji) da uzmeš override-e
    const ref = doc(db, "users", phoneNorm);
    const oldSnap = await getDoc(ref);
    const old = oldSnap.exists() ? oldSnap.data() : {};

   const special = SPECIAL_ROLES[phoneNorm] || {};

const computedIsAdmin = phoneNorm === ADMIN_PHONE;

// specijalno pravilo ima prioritet, zatim vrednosti iz baze, pa default
const isAdmin = special.isAdmin ?? old?.isAdmin ?? computedIsAdmin;

// default: finansije samo ako je admin (osim ako specijalno kaže drugačije)
const isFinance = special.isFinance ?? old?.isFinance ?? (isAdmin ? true : false);


    const role = isAdmin ? "admin" : "client";

    await setDoc(
      ref,
      {
        firstName: fn || null,
        lastName: ln || null,
        phone: phoneNorm,
        role,
        isAdmin,
        isFinance,
        updatedAt: serverTimestamp(),
        createdAt: old?.createdAt ?? serverTimestamp(),
      },
      { merge: true }
    );

    const sessionUser = {
      id: phoneNorm,
      firstName: fn,
      lastName: ln,
      phone: phoneNorm,
      role,
      isAdmin,
      isFinance,
    };
    setUser(sessionUser);
    return sessionUser;
  };

  const logout = () => {
    try { localStorage.removeItem("abeauty:user"); } catch {}
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, isLoggedIn: !!user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
