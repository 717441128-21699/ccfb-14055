# 邮票扫描鉴定工具（Stamp Grading Toolkit）

把邮票扫描件导入后，自动完成票幅/边框检测、四边齿孔度数、图案居中、刷色、
背面透光水印识别，并按 **年份 / 套票 / 票号** 归档，输出中文评审证书 PDF。
全部代码用 TypeScript 编写，仅依赖纯 JS 库（pngjs、pdf-lib、fontkit），
无原生模块，可在 Windows / macOS / Linux 直接运行。

## 能力与对应需求

| 需求 | 实现 |
| --- | --- |
| 齿孔度数按每 20mm 孔数，精确到 0.25，四边分开，撕坏不计入 | `pipeline/perforation.ts`：稳健晶格拟合，原始度数 + 归整到 0.25；`torn/half/double/missing` 全部从度数计算中剔除 |
| 打孔机歪打的半孔、双孔、漏打单独识别 | 同一模块基于孔深、孔宽、晶格漂移和局部咬口分类，逐孔给出中文说明 |
| 居中按四边白边宽度，误差 0.05mm 量级，自动换算不同扫描仪分辨率 | `pipeline/centering.ts`：矫正后正视图上做亚像素框线定位；所有几何经 DPI 标定，300/600 DPI 结果一致（实测位移误差 ≤0.06mm） |
| 测试扫描件：常见齿孔/水印、撕坏霉斑 | `synthetic/`：物理尺寸渲染，齿孔度数 11–14、四种水印 + 无水印、撕坏/半孔/双孔/漏打/霉斑 |
| 背面透光水印识别 | `pipeline/watermark.ts`：光照归一化 + Hann 窗多尺度归一化相关，花环/五角星/皇冠/祥云/无水印五类 |
| 按套票年份存档 + 评审证书 PDF | `archive/`（`年份/套票/票号` 目录 + index.json）、`certificate/pdf.ts`（A4、内嵌中文字体子集） |

## 目录结构

```
src/
  types.ts            领域类型
  util/               数值/几何/随机数工具
  image/              灰度/RGB 图、滤波、形态学、连通域、PNG 读写（含 pHYs/DPI）
  synthetic/          合成扫描件生成器与场景矩阵（带 ground truth JSON）
  catalog/            虚拟票品目录（志号、年份、套票、标准色、水印、齿孔规格）
  pipeline/
    frame.ts          边框/票幅/倾角检测（PCA + 最小面积外接矩形）
    rectEdge.ts       矫正图四边齿孔深度剖面
    perforation.ts    找孔、晶格拟合、缺陷分类、度数计算
    centering.ts      设计框与四边白边
    color.ts          sRGB→Lab、CIEDE2000、参考色邻域刷色测量
    watermark.ts      水印模板与模板匹配
    mildew.ts         霉斑（黄斑）检测
    analyze.ts        流水线编排
  archive/            JSON 归档
  certificate/        PDF 证书
  cli/                命令行入口
tests/                Vitest 单元测试 + 端到端真值校验
```

## 使用

依赖 Node 18+。安装：

```bash
npm install
```

生成一批带真值的合成扫描件（11 个场景，300/600 DPI、正/背面）：

```bash
npm run generate -- --out data/generated
```

分析单张（DPI 从 PNG 的 pHYs 元数据读取；缺失时可用 `--dpi` 覆盖）：

```bash
npm run analyze -- --file data/generated/scans/T28-2-front-300dpi.png \
  --side front --catalog T28-2 --overlay out/overlay.png
```

一键生成 → 分析 → 按年份/套票归档 → 出 PDF 证书：

```bash
npm run demo -- --out data/demo
```

其它命令：`npm run build`（编译到 dist/）、`npm test`（全部测试）。

## 关键设计说明

- **DPI 自治**：PNG 写入真实 pHYs 块，读取后像素↔毫米严格换算，同一枚票在
  300 与 600 DPI 下测出的度数/居中一致。
- **矫正后分析**：先去旋转得到轴对齐正视图并保留 3mm 扫描仪背景边距，齿孔剖面、
  居中、水印都在物理坐标下进行，避免斜采样带来的方向偏差。
- **缺陷不污染度数**：晶格拟合只用正常孔与双孔中点，半孔/撕裂/漏打只报告、不入算。
- **刷色**：在目录标准色的 Lab 邻域内取稳健中位色，避免深色图案或其它配色干扰。
- **测试即规格**：`tests/e2e.test.ts` 用合成器输出的 ground truth 校验票幅、倾角、
  四边度数、DPI 独立性、缺陷分类、居中、水印、霉斑共 10 组断言。
