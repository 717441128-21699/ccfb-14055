# 邮票扫描鉴定工具（Stamp Perforation Evaluator）

面向集邮协会评审场景的纯 TypeScript 工具：导入邮票正反面扫描件，自动定位边框与每一个齿孔，
计算齿孔度数、图案居中、刷色色差、背透光水印与霉斑/撕坏等瑕疵，按套票与年份归档并出具中文评审证书 PDF。

## 能力与指标

| 评审项 | 方法 | 输出精度 / 判据 |
| --- | --- | --- |
| 齿孔度数 | 沿四边追踪「底板→票纸」跃变边界，孔位内凹成峰，众数孔距换算 `20/孔距` | 按 **0.25 度**取整，四边分别报 |
| 异常孔 | 半孔（深而窄）、双孔（宽峰分裂为两个等深瓣）、漏打（约 2 倍孔距空缺）、撕坏（宽而深的粗糙缺损） | 全部剔除出度数计算，附沿边坐标 |
| 图案居中 | 四边内法线扫描纸边→图案的亚像素下降沿 | 白边宽度毫米，偏移误差实测 ≤0.1mm（要求 0.05mm 量级，亚像素插值） |
| 刷色 | 票幅内多点采样转 Lab，与标准票基准做 **CIEDE2000** 色差 | ΔE、ΔL/Δa/Δb、五级判定 |
| 背透水印 | 背面图高通滤波增强压痕，与 5 种内置水印模板做归一化互相关 NCC | 图案名、匹配分、朝向（0/180°） |
| 霉斑 | 相对邻域底色的黄褐偏移 + 近圆形连通域过滤 | 每处中心坐标与面积 mm² |
| 分辨率适配 | 读取 PNG pHYs/JFIF DPI，或 `--dpi` 显式指定，全部物理量按 px/mm 换算 | 300/400/600 DPI 毫米级结果一致 |

## 目录结构

```
src/
  geometry.ts          凸包、最小外接矩形、双线性采样、旋转校正
  io.ts                PNG/JPEG 读写与分辨率元数据（pHYs/JFIF）
  types.ts             共享类型
  vision/
    border.ts          Otsu 分割 + 形态学闭运算 + 凸包最小外接矩形定位票框
    perforation.ts     齿孔轮廓追踪、峰检测、半孔/双孔/漏打/撕坏分类、度数计算
    centering.ts       角点几何内法线扫描，亚像素白边测量
    colorAnalysis.ts   Lab 刷色比对与霉斑检测
    color.ts           sRGB↔Lab、CIEDE2000、色差分级
    watermark.ts       高通增强 + NCC 水印模板匹配
    filters.ts         高斯/Otsu/形态学/连通域
  fixture/
    generator.ts       扫描件合成器（齿孔、半孔/双孔/漏打/撕坏、霉斑、水印、旋转）
    patterns.ts        五种水印图案（波浪/五角星/皇冠/菱格/水字）
    presets.ts         四套演示测试件预设与标准参考件
  catalog.ts           标准票参考库 + 年份/套票归档索引
  certificate.ts       中文 A4 评审证书 PDF（自动嵌入系统中文字体）
  pipeline.ts          端到端分析流水线
  cli/index.ts         命令行入口
tests/pipeline.test.ts 基于 ground truth 的 8 项自动化测试
```

## 快速开始

```bash
npm install
npm run build          # 类型检查 + 编译到 dist/

# 一键演示：合成测试件 → 分析 → 按年份/套票归档 → 出证书
npx tsx src/cli/index.ts demo

# 仅合成带 ground truth 的测试扫描件
npx tsx src/cli/index.ts generate-fixtures --out data/fixtures

# 登记标准票参考（标称齿孔度数、标准刷色、水印）
npx tsx src/cli/index.ts add-reference \
  --image REF-T1980-1A_front.png --catalog-no T1980-1A \
  --year 1980 --set T46 --name 庚申年演示票 --gauge-top 11.5

# 分析真实扫描件（正反面）
npx tsx src/cli/index.ts analyze \
  --front 正面.png --back 背面.png --catalog-no T1980-1A --dpi 300

# 单独出具证书
npx tsx src/cli/index.ts certificate \
  --result data/catalog/1980/T46/T1980-1A.analysis.json --image 正面.png

# 按年份/套票检索档案
npx tsx src/cli/index.ts list --year 1980
```

## 运行测试

```bash
npm test
```

测试用合成器生成已知 ground truth 的票件，断言：四边齿孔度数误差 ≤0.25 度、居中偏移 ≤0.1mm、
不同 DPI 毫米级一致、四类异常孔均被识别且不参与度数、四种水印全部正确识别、刷色偏移方向正确、
票幅/倾角定位精度、ground truth 可解析。

## 设计要点

- **不依赖 OpenCV/原生模块**：图像算法全部用 TypeScript 实现，仅依赖 pngjs、jpeg-js、pdf-lib、fontkit。
- **方向无关的齿孔追踪**：从边点沿法向双向扫描，自动识别底板（暗）→票纸（亮）跃变，
  避免旋转角符号导致的左右/上下边标签互换。
- **异常孔不污染度数**：双孔、半孔、撕坏、漏打在孔距估计前剔除，基准孔距用聚类众数而非中位数，
  抗漏打造成的 2 倍间隔离群。
- **测试件即验证基准**：合成器输出的每张图都带 `*.truth.json`，检测算法的正确性可量化回归。

## 局限与后续

- 霉斑在复杂实色图案上仍有误报，当前以「近圆形软斑 + 局部黄褐偏移」约束，结果作为候选供评审复核。
- 水印模板库目前内置 5 种，可通过扩展 `fixture/patterns.ts` 增补；真实扫描件建议先用 `add-reference` 建库。
- 证书字体优先使用 Windows 自带 Deng.ttf/simhei.ttf，Linux/macOS 回退到 Noto CJK / PingFang。
