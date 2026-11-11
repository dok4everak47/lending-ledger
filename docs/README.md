# docs

`console.png` 由 `scripts/screenshot.sh` 生成，用作 README 的截图。

```bash
npm run serve            # 终端 A
./scripts/screenshot.sh  # 终端 B
```

首次 clone 时这个文件不存在，README 里也不引用它，所以不会出现坏图。截好之后把 `![操作台](docs/console.png)` 加回 README 的「操作台」小节即可。
