from cryptography.fernet import Fernet, InvalidToken


class SecretConfigurationError(RuntimeError):
    pass


class SecretDecryptionError(RuntimeError):
    pass


class SecretCipher:
    def __init__(self, encryption_key: str) -> None:
        try:
            self._fernet = Fernet(encryption_key.encode("ascii"))
        except (ValueError, UnicodeEncodeError) as exc:
            raise SecretConfigurationError(
                "MASTER_ENCRYPTION_KEY must be a valid Fernet key"
            ) from exc

    def encrypt(self, value: str) -> str:
        return self._fernet.encrypt(value.encode("utf-8")).decode("ascii")

    def decrypt(self, value: str) -> str:
        try:
            return self._fernet.decrypt(value.encode("ascii")).decode("utf-8")
        except (InvalidToken, UnicodeError) as exc:
            raise SecretDecryptionError("Stored secret cannot be decrypted") from exc


def secret_mask(value: str) -> str:
    if len(value) <= 7:
        return f"{value[:2]}••••{value[-1:]}"
    return f"{value[:4]}••••••••{value[-3:]}"
