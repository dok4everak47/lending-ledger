# docs

- `console.png` —— 操作台截图，README 的「操作台」小节直接引用。
- `design-notes.md` —— 设计笔记：几个「本来可以另一个写法」的决定，以及各自的代价。

重新截图，两种方式：

```bash
# A. 用本机的 Chrome / Chromium / Edge / Brave（脚本自动找，找不到就提示手截）
npm run serve
./scripts/screenshot.sh

# B. 用 Playwright 自带的 Chromium（不依赖本机浏览器）
npx playwright install chromium
node scripts/capture.mjs   # 先另开终端 npm run serve
```

截图里的数据是造出来的示例：几笔历史结算 + 一笔当天的支付与结算，然后点一次「重发」和「跑一次对账」。目标是让五类差异里四类各有一条、第五类为 0，这样看图的人能立刻判断分类器不是把什么都塞进同一个桶。
