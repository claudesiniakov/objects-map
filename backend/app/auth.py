import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, Header, HTTPException, Request

from .config import SECRET, TOKEN_HOURS
from .db import get_db

ROLE_LEVEL = {"viewer": 1, "operator": 2, "admin": 3}

_failed_logins: dict[str, deque] = defaultdict(deque)
LOGIN_WINDOW_S = 600
LOGIN_MAX_FAILS = 10


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def check_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except ValueError:
        return False


def make_token(user) -> str:
    payload = {
        "sub": str(user["id"]),
        "role": user["role"],
        "exp": datetime.now(timezone.utc) + timedelta(hours=TOKEN_HOURS),
    }
    return jwt.encode(payload, SECRET, algorithm="HS256")


def client_ip(request: Request) -> str:
    return request.headers.get("x-real-ip") or (request.client.host if request.client else "?")


def login_blocked(ip: str) -> bool:
    q = _failed_logins[ip]
    cutoff = time.monotonic() - LOGIN_WINDOW_S
    while q and q[0] < cutoff:
        q.popleft()
    return len(q) >= LOGIN_MAX_FAILS


def register_failed_login(ip: str):
    _failed_logins[ip].append(time.monotonic())


def current_user(authorization: str | None = Header(None), db=Depends(get_db)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Требуется вход в систему")
    try:
        payload = jwt.decode(authorization[7:], SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(401, "Сессия истекла, войдите заново")
    user = db.execute("SELECT * FROM user WHERE id = ? AND active = 1", (int(payload["sub"]),)).fetchone()
    if not user:
        raise HTTPException(401, "Пользователь не найден или отключён")
    return dict(user)


def require(role: str):
    def dep(user=Depends(current_user)):
        if ROLE_LEVEL[user["role"]] < ROLE_LEVEL[role]:
            raise HTTPException(403, "Недостаточно прав")
        return user

    return dep
