import ipaddress
import socket
from urllib.parse import urlsplit, urlunsplit


class InvalidProviderURLError(ValueError):
    pass


def validate_ollama_base_url(value: str, allowed_hosts: set[str]) -> str:
    normalized_input = value.strip()
    parsed = urlsplit(normalized_input)
    if parsed.scheme not in {"http", "https"}:
        raise InvalidProviderURLError("Ollama URLはhttpまたはhttpsを使用してください")
    if not parsed.hostname or parsed.username or parsed.password:
        raise InvalidProviderURLError("Ollama URLのホストが不正です")
    if parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise InvalidProviderURLError("Ollama URLにpath、query、fragmentは指定できません")

    hostname = parsed.hostname.lower().rstrip(".")
    normalized_allowed_hosts = {host.lower().rstrip(".") for host in allowed_hosts}
    if hostname not in normalized_allowed_hosts:
        addresses = _resolve_addresses(hostname, parsed.port)
        if any(not address.is_global for address in addresses):
            raise InvalidProviderURLError(
                "Private networkのOllama hostはOLLAMA_ALLOWED_HOSTSへの登録が必要です"
            )

    netloc = hostname
    if ":" in hostname and not hostname.startswith("["):
        netloc = f"[{hostname}]"
    if parsed.port is not None:
        netloc = f"{netloc}:{parsed.port}"
    return urlunsplit((parsed.scheme, netloc, "", "", ""))


def _resolve_addresses(
    hostname: str, port: int | None
) -> set[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    try:
        return {ipaddress.ip_address(hostname)}
    except ValueError:
        pass
    try:
        records = socket.getaddrinfo(hostname, port or 80, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise InvalidProviderURLError("Ollama URLのホストを解決できません") from exc
    return {ipaddress.ip_address(record[4][0]) for record in records}
