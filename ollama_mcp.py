#!/usr/bin/env python3
"""MCP server that wraps Ollama's API, exposing local LLMs as tools for Goose.

Runs on aitopatom (DGX Spark #1) and exposes tools via MCP streamable HTTP.
Goose on aitop2 connects to this server as an extension.

Usage:
    pip install mcp[cli] httpx
    python ollama_mcp.py

Or with uvx:
    uvx --from "mcp[cli]" mcp run ollama_mcp.py
"""
import json
import logging
import os
import urllib.request
import urllib.error
from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
DEFAULT_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3:30b")
PORT = int(os.environ.get("MCP_PORT", "8001"))

mcp = FastMCP(
    "Ollama (aitopatom GPU)",
    instructions="Local LLM running on DGX Spark — code analysis, summarization, text generation",
    host="0.0.0.0",
    port=PORT,
)


def _ollama_generate(prompt: str, model: str = None, system: str = None,
                     temperature: float = 0.7, max_tokens: int = 4096) -> str:
    """Call Ollama's generate API and return the response text."""
    model = model or DEFAULT_MODEL
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": {
            "temperature": temperature,
            "num_predict": max_tokens,
        },
    }
    if system:
        payload["system"] = system

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            return result.get("response", "")
    except urllib.error.URLError as e:
        return f"Error calling Ollama: {e}"
    except Exception as e:
        return f"Error: {e}"


def _ollama_chat(messages: list, model: str = None,
                 temperature: float = 0.7, max_tokens: int = 4096) -> str:
    """Call Ollama's chat API with a list of messages."""
    model = model or DEFAULT_MODEL
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "options": {
            "temperature": temperature,
            "num_predict": max_tokens,
        },
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            return result.get("message", {}).get("content", "")
    except urllib.error.URLError as e:
        return f"Error calling Ollama: {e}"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def generate(prompt: str, model: str = "", temperature: float = 0.7,
             max_tokens: int = 4096) -> str:
    """Generate text using a local LLM on the GPU server.

    Args:
        prompt: The text prompt to send to the model
        model: Model name (default: qwen3:30b). Available: qwen3:30b, qwen2.5:1.5b
        temperature: Sampling temperature (0.0-2.0, default 0.7)
        max_tokens: Maximum tokens to generate (default 4096)
    """
    log.info(f"generate: model={model or DEFAULT_MODEL} prompt={prompt[:80]}...")
    return _ollama_generate(prompt, model or None, temperature=temperature,
                            max_tokens=max_tokens)


@mcp.tool()
def analyze_code(code: str, instruction: str = "Review this code for bugs, performance issues, and improvements.",
                 model: str = "") -> str:
    """Analyze code using a local LLM. Good for code review, bug finding, and optimization suggestions.

    Args:
        code: The source code to analyze
        instruction: What kind of analysis to perform
        model: Model name (default: qwen3:30b)
    """
    log.info(f"analyze_code: {len(code)} chars, instruction={instruction[:60]}...")
    system = "You are an expert code reviewer. Analyze the code carefully and provide specific, actionable feedback."
    prompt = f"{instruction}\n\n```\n{code}\n```"
    return _ollama_generate(prompt, model or None, system=system, temperature=0.3)


@mcp.tool()
def summarize(text: str, style: str = "concise", model: str = "") -> str:
    """Summarize text using a local LLM.

    Args:
        text: The text to summarize
        style: Summary style — 'concise' (1-2 sentences), 'detailed' (paragraph), or 'bullets' (bullet points)
        model: Model name (default: qwen3:30b)
    """
    log.info(f"summarize: {len(text)} chars, style={style}")
    style_instructions = {
        "concise": "Provide a 1-2 sentence summary.",
        "detailed": "Provide a detailed paragraph summary covering all key points.",
        "bullets": "Provide a summary as bullet points, one per key point.",
    }
    instruction = style_instructions.get(style, style_instructions["concise"])
    system = f"You are a precise summarizer. {instruction}"
    prompt = f"Summarize the following:\n\n{text}"
    return _ollama_generate(prompt, model or None, system=system, temperature=0.3)


@mcp.tool()
def chat(message: str, system_prompt: str = "", model: str = "",
         temperature: float = 0.7) -> str:
    """Have a conversation with a local LLM. Useful for brainstorming, Q&A, and general tasks.

    Args:
        message: Your message to the model
        system_prompt: Optional system prompt to set the model's behavior
        model: Model name (default: qwen3:30b)
        temperature: Sampling temperature (default 0.7)
    """
    log.info(f"chat: model={model or DEFAULT_MODEL} msg={message[:80]}...")
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": message})
    return _ollama_chat(messages, model or None, temperature=temperature)


@mcp.tool()
def list_models() -> str:
    """List all available models on the Ollama server."""
    try:
        req = urllib.request.Request(f"{OLLAMA_URL}/api/tags")
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            models = result.get("models", [])
            lines = []
            for m in models:
                size_gb = m.get("size", 0) / 1e9
                details = m.get("details", {})
                lines.append(
                    f"- {m['name']} ({size_gb:.1f}GB, {details.get('parameter_size', '?')}, "
                    f"{details.get('quantization_level', '?')})"
                )
            return "\n".join(lines) if lines else "No models found"
    except Exception as e:
        return f"Error listing models: {e}"


if __name__ == "__main__":
    log.info(f"Starting Ollama MCP server on port {PORT}")
    log.info(f"Ollama API: {OLLAMA_URL}, Default model: {DEFAULT_MODEL}")
    mcp.run(transport="streamable-http")
