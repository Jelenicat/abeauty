// src/context/AuthContext.jsx
import { createContext, useContext, useEffect, useState } from "react";
import { db } from "../firebase";
import { doc, setDoc, serverTimestamp, getDoc } from "firebase/firestore";
import { ensureFcmToken, deleteCurrentFcmToken } from "../utils/fcm";

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

  // sync sa localStorage
  useEffect(() => {
    if (user) localStorage.setItem("abeauty:user", JSON.stringify(user));
    else localStorage.removeItem("abeauty:user");
  }, [user]);

  // ako postoji user posle refresh-a, obezbedi FCM token za ovaj uređaj
  useEffect(() => {
    if (user?.phone) ensureFcmToken(user.phone);
  }, [user?.phone]);

  // login: upis user-a + određivanje rola
  const login = async ({ firstName, lastName, phone }) => {
    const fn = String(firstName || "").trim();
    const ln = String(lastName || "").trim();
    const phoneNorm = normalizePhone(phone);

    // pročitaj postojeći doc radi override-a
    const ref = doc(db, "users", phoneNorm);
    const oldSnap = await getDoc(ref);
    const old = oldSnap.exists() ? oldSnap.data() : {};

    const special = SPECIAL_ROLES[phoneNorm] || {};
    const computedIsAdmin = phoneNorm === ADMIN_PHONE;

    // prioritet: SPECIAL_ROLES -> vrednosti iz baze -> default
    const isAdmin = special.isAdmin ?? old?.isAdmin ?? computedIsAdmin;
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
    // opcionalno: možeš izostaviti ovaj poziv jer ga useEffect već radi nakon setUser
    ensureFcmToken(sessionUser.phone);

    return sessionUser;
  };

  // JEDINA verzija logout-a (asinhrona): briše FCM token + localStorage
  const logout = async () => {
    try { await deleteCurrentFcmToken(); } catch {}
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
