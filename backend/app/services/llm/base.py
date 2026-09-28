from typing import Protocol, TypeVar

from pydantic import BaseModel

StructuredOutput = TypeVar("StructuredOutput", bound=BaseModel)


class LLMProvider(Protocol):
    async def generate_structured(
        self,
        system_prompt: str,
        prompt: str,
        schema: type[StructuredOutput],
    ) -> StructuredOutput: ...

    async def test_connection(self) -> None: ...

    async def list_models(self) -> list[str]: ...


class LLMProviderError(RuntimeError):
    pass
