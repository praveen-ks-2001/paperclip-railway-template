#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const vulnerableFragment = "}),u=o.companies,d=o.unauthorized,f=x.useMemo(()=>u.filter(N=>N.status!==\"archived\"),[u]);";
const patchedFragment = "}),u=Array.isArray(o&&o.companies)?o.companies:[],d=!!(o&&o.unauthorized),f=x.useMemo(()=>u.filter(N=>N.status!==\"archived\"),[u]);";
const vulnerableAccessEffect = "if(!V.data||!((Z=P.data)!=null&&Z.companyId))return;V.data.some(ze=>ze.id===P.data.companyId)&&(nD(r),t(\"/\",{replace:!0}))";
const patchedAccessEffect = "if(!Array.isArray(V.data)||!((Z=P.data)!=null&&Z.companyId))return;V.data.some(ze=>ze.id===P.data.companyId)&&(nD(r),t(\"/\",{replace:!0}))";
const vulnerableAccessFlag = "U=!!(H!=null&&H.companyId)&&!!((Te=V.data)!=null&&Te.some(xe=>xe.id===(H==null?void 0:H.companyId)))";
const patchedAccessFlag = "U=!!(H!=null&&H.companyId)&&Array.isArray(Te=V.data)&&Te.some(xe=>xe.id===(H==null?void 0:H.companyId))";

function resolveServerPackageRoot() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "node_modules", "@paperclipai", "server"),
    join(scriptDir, "..", "node_modules", "@paperclipai", "server"),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }

  throw new Error(`Unable to locate @paperclipai/server package. Checked: ${candidates.join(", ")}`);
}

function patchUiBundle() {
  const packageRoot = resolveServerPackageRoot();
  const assetsDir = join(packageRoot, "ui-dist", "assets");
  if (!existsSync(assetsDir)) {
    throw new Error(`Paperclip UI assets directory not found: ${assetsDir}`);
  }

  const bundles = readdirSync(assetsDir)
    .filter((name) => /^index-.*\.js$/.test(name))
    .map((name) => join(assetsDir, name));

  if (bundles.length === 0) {
    throw new Error(`No Paperclip UI index bundle found in ${assetsDir}`);
  }

  let patched = 0;
  let alreadyPatched = 0;
  for (const bundle of bundles) {
    let source = readFileSync(bundle, "utf8");
    let nextSource = source;

    if (nextSource.includes(vulnerableFragment)) {
      nextSource = nextSource.replace(vulnerableFragment, patchedFragment);
    }
    if (nextSource.includes(vulnerableAccessEffect)) {
      nextSource = nextSource.replace(vulnerableAccessEffect, patchedAccessEffect);
    }
    if (nextSource.includes(vulnerableAccessFlag)) {
      nextSource = nextSource.replace(vulnerableAccessFlag, patchedAccessFlag);
    }

    if (nextSource !== source) {
      writeFileSync(bundle, nextSource);
      patched += 1;
      continue;
    }

    if (
      source.includes(patchedFragment) &&
      source.includes(patchedAccessEffect) &&
      source.includes(patchedAccessFlag)
    ) {
      alreadyPatched += 1;
    }
  }

  if (patched === 0 && alreadyPatched === 0) {
    throw new Error("Paperclip UI invite patch targets were not found. The bundled UI may have changed.");
  }

  const status = patched > 0 ? "patched" : "already patched";
  console.log(`Paperclip UI invite guards ${status} (${patched || alreadyPatched} bundle${(patched || alreadyPatched) === 1 ? "" : "s"}).`);
}

patchUiBundle();
