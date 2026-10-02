# charts — markdown 渲染能力展示 (mermaid + KaTeX)

## 流程图 (mermaid)

```mermaid
flowchart LR
  A[浏览器] -->|WS 二进制帧| B[shell-server]
  B -->|docker run --rm| C[隔离容器]
  C -->|zsh + fzf + p10k| D{真终端}
  D -->|OSC 7770| A
```

## 时序图 (mermaid)

```mermaid
sequenceDiagram
  participant U as 键盘
  participant X as xterm.js
  participant S as node-pty
  participant Z as zsh
  U->>X: 按键
  X->>S: stdin 字节
  S->>Z: PTY
  Z-->>S: 输出 (ANSI)
  S-->>X: WS binary
  X-->>U: 渲染
```

## 数学 (KaTeX)

欧拉恒等式:

$$e^{i\pi} + 1 = 0$$

行内公式: 终端尺寸 $\text{cols} \times \text{rows}$, 高斯积分 $\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}$。

## 代码块

```python
def fib(n: int) -> int:
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
```

> 占位素材 — 结构已就绪，内容待替换。
