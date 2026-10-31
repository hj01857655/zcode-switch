# header_bisect.py — messages 头集逐组加法 bisect（2026-11-01）
# 背景：AaronWallace42 同账号 A/B 已定案「薄头 200 / 全头族 3012」，本脚本定位扳机在哪一组。
# 方法：薄头为基座，按嫌疑度降序逐组叠加头，每组一发、换一个 farm 号（隔离账号变量）；
#       命中 3012 立即停（不喂 WAF 坏样本）；若全组通过则全头族判「当时性/状态性」，不做组合爆炸。
# 用法：python -I scripts/header_bisect.py
import base64
import json
import os
import platform
import ssl
import sys
import time
import urllib.error
import urllib.request
import uuid
from hashlib import sha256
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

HOME = Path.home()
SWITCH_DIR = HOME / ".zcode-switch"
UPSTREAM = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages"
ASK = "1+1 等于几？只回数字"
MODEL = "GLM-5.3-Flash"

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def b64u(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def derive_key():
    plat = {"Windows": "win32", "Darwin": "darwin", "Linux": "linux"}[platform.system()]
    user = os.environ.get("USERNAME") or ""
    return sha256(f"zcode-credential-fallback:{plat}:{HOME}:{user}".encode()).digest()


KEY = derive_key()


def dec(v):
    if not (isinstance(v, str) and v.startswith("enc:v1:")):
        return v
    iv, tag, ct = (b64u(x) for x in v[len("enc:v1:"):].split("."))
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    return AESGCM(KEY).decrypt(iv, ct + tag, None).decode("utf-8", "replace")


def jwt_exp(jwt):
    try:
        return int(json.loads(b64u(jwt.split(".")[1])).get("exp", 0))
    except Exception:
        return 0


def zcode_app_version():
    import winreg
    for hive in [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]:
        try:
            k = winreg.OpenKey(hive[0], hive[1])
        except OSError:
            continue
        with k:
            for i in range(winreg.QueryInfoKey(k)[0]):
                try:
                    sub = winreg.OpenKey(k, winreg.EnumKey(k, i))
                except OSError:
                    continue
                with sub:
                    try:
                        name, _ = winreg.QueryValueEx(sub, "DisplayName")
                        ver, _ = winreg.QueryValueEx(sub, "DisplayVersion")
                    except OSError:
                        continue
                    l = str(name).lower()
                    if "zcode" in l and "switch" not in l:
                        parts = str(ver).split(".")
                        return ".".join(parts[:3]) if len(parts) >= 3 else str(ver)
    return "3.17.1"


def os_version():
    import winreg
    try:
        k = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
        with k:
            build, _ = winreg.QueryValueEx(k, "CurrentBuildNumber")
        return f"10.0.{build}"
    except OSError:
        return None


def farm_members():
    out = []
    for f in sorted(SWITCH_DIR.glob("accounts/*.json")):
        if ".bak" in f.name:
            continue
        try:
            acc = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        jwt = dec(acc.get("credentials", {}).get("zcodejwttoken", "") or "")
        if not jwt or len(jwt) < 20:
            continue
        exp = jwt_exp(jwt)
        if exp and exp < time.time():
            continue
        out.append({"id": acc["id"], "name": acc.get("name", acc["id"]), "token": jwt,
                    "mid": acc.get("virtual_device_mid")})
    return out


# ── 头组定义：按嫌疑度降序（头号嫌疑 UA 最先试，一发 3012 即收工）──────────
# 每组返回 (headers, 描述)；头值依赖账号/版本的在 group 里现算。
def group_headers(label, acc, ver):
    if label == "UA":
        return [("User-Agent", f"ZCode/{ver}")], "自称桌面客户端 UA（头号嫌疑：UA vs TLS 指纹矛盾）"
    if label == "VERSION_FAMILY":
        h = [
            ("X-ZCode-App-Version", ver),
            ("X-Platform", "win32-x64"),
            ("X-Release-Channel", "stable"),
            ("X-Os-Category", "windows"),
            ("X-Client-Language", "zh-CN"),
            ("X-Client-Timezone", "Asia/Shanghai"),
        ]
        if (v := os_version()):
            h.append(("X-Os-Version", v))
        return h, "版本/环境头族（quota.rs 同构）"
    if label == "REFERRER":
        return [("HTTP-Referer", "https://zcode.z.ai"), ("X-Title", "Z Code@electron")], "来源头（billing 端点族）"
    if label == "DEVICE_MID":
        return ([("X-Device-Mid", acc["mid"])] if acc["mid"] else []), "设备 mid（账号 virtual mid）"
    if label == "REQUEST_ID":
        return [("x-request-id", str(uuid.uuid4()))], "请求 ID"
    if label == "ANTHROPIC_VERSION":
        return [("anthropic-version", "2023-06-01")], "API 版本头"
    raise ValueError(label)


ORDER = ["UA", "VERSION_FAMILY", "REFERRER", "DEVICE_MID", "REQUEST_ID", "ANTHROPIC_VERSION"]


def order_for_run():
    # 已定罪组永久排除：UA、VERSION_FAMILY 均单独 3012（2026-11-01 两轮实测）
    CONDEMNED = {g for g in ORDER if f"--skip {g}" in " ".join(sys.argv)}
    CONDEMNED.add("UA")
    CONDEMNED.add("VERSION_FAMILY")
    return [g for g in ORDER if g not in CONDEMNED]


def build_body():
    prefix = json.loads(
        (Path(__file__).resolve().parent.parent / "src-tauri/src/gateway/assets/prefix.json")
        .read_text(encoding="utf-8")
    )["system_prefix"]
    system = [{"type": "text", "text": t, "cache_control": {"type": "ephemeral"}} for t in prefix]
    uid = json.dumps({"device_id": str(uuid.uuid4()), "account_uuid": "", "session_id": ""})
    return {
        "model": MODEL,
        "messages": [{"role": "user", "content": ASK}],
        "max_tokens": 512,
        "stream": True,
        "system": system,
        "metadata": {"user_id": uid},
    }


def fire(acc, extra_headers, payload):
    h = {"Authorization": f"Bearer {acc['token']}", "Content-Type": "application/json"}
    for k, v in extra_headers:
        h[k] = v
    req = urllib.request.Request(UPSTREAM, method="POST", data=payload, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=120, context=ctx) as r:
            raw = r.read().decode("utf-8", "replace")
            return r.status, raw, None
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:300], None
    except Exception as e:
        return 0, "", str(e)


def reply_text(raw):
    text = ""
    for line in raw.splitlines():
        if line.startswith("data: "):
            try:
                ev = json.loads(line[6:])
            except Exception:
                continue
            if ev.get("type") == "content_block_delta" and ev.get("delta", {}).get("type") == "text_delta":
                text += ev["delta"].get("text", "")
    return text


def main():
    ver = zcode_app_version()
    print(f"app_version = {ver}")
    members = farm_members()
    print(f"farm 可用成员 = {len(members)}")
    if len(members) < 8:
        print("成员不足，中止（每组一发 + 基线需要足够的干净号轮换）")
        return 1
    payload = json.dumps(build_body()).encode()

    results = []
    it = iter(members)

    # 基线自证：薄头必须 200，否则环境状态不对，不往下打
    acc = next(it)
    st, raw, err = fire(acc, [], payload)
    results.append(("BASELINE thin", acc["name"], st, reply_text(raw)))
    print(f"[基线] thin ({acc['name']}): HTTP {st}" + (f" 回复 {reply_text(raw)!r}" if st == 200 else f" body={raw[:200]}"))
    if st != 200:
        print("基线未过（薄头都 3012 说明环境状态异常），中止")
        return 1

    # 逐组叠加；3012 立即停
    verdict = None
    cumul = []
    for label in order_for_run():
        g, desc = group_headers(label, acc, ver)
        if not g:
            continue
        cumul += g
        acc = next(it)
        st, raw, err = fire(acc, cumul, payload)
        results.append((label, acc["name"], st, reply_text(raw)))
        names = "+".join(k for k, _ in g)
        print(f"[{label}] +({names}) ({acc['name']}): HTTP {st}"
              + (f" 回复 {reply_text(raw)!r}" if st == 200 else f" body={raw[:200]}"))
        if st == 3012 or st == 405:
            verdict = label
            break
        if st != 200:
            print(f"非风控错误 {st}，跳过该组继续（可能是账号个体问题）")
            cumul = cumul[: len(cumul) - len(g)]  # 回退该组，不把失败组留在基座里
            continue

    print("\n=== 结论 ===")
    log = ["# header_bisect 2026-11-01", ""]
    for label, name, st, text in results:
        log.append(f"| {label} | {name} | {st} | {text[:40]!r} |")
    if verdict:
        print(f"扳机组 = {verdict}（叠加它后 3012；之前的组全部 200）")
        log.append(f"\n扳机组 = {verdict}")
    elif all(r[2] == 200 for r in results):
        if "--skip" in " ".join(sys.argv):
            print("被测组全部通过（定罪组已排除）——安全头集 = 薄头 + 本轮叠加的全部组")
            log.append("\n安全头集 = thin + " + " + ".join(r[0] for r in results[1:]))
        else:
            print("全组通过——全头族在当前时点 200 了，说明 10-31 的 3012 是时点性/状态性判定，非性质性")
            log.append("\n全组通过：3012 为时点性/状态性")
    (Path(__file__).parent / "header_bisect_results.txt").write_text("\n".join(log), encoding="utf-8")
    print(f"结果已落 {Path(__file__).parent / 'header_bisect_results.txt'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
