import { NETWORK_CONFIGS } from "../util/networkConfig";
import * as fs from "fs";
import * as path from "path";

const universalRouters: Record<string, string> = {
  op:         "0x8B844f885672f333Bc0042cB669255f93a4C1E6b",
  base:       "0xFdf682F51FE81Aa4898F0AE2163d8A55c127fbC7",
  worldchain: "0x8B844f885672f333Bc0042cB669255f93a4C1E6b",
  bsc:        "0x8B844f885672f333Bc0042cB669255f93a4C1E6b",
  polygon:    "0x8B844f885672f333Bc0042cB669255f93a4C1E6b",
  arbitrum:   "0x8B844f885672f333Bc0042cB669255f93a4C1E6b",
  avax:       "0x8B844f885672f333Bc0042cB669255f93a4C1E6b",
  linea:      "0x8B844f885672f333Bc0042cB669255f93a4C1E6b",
  blast:      "0x8B844f885672f333Bc0042cB669255f93a4C1E6b",
  scroll:     "0x595E7160858b1AdA94Bda790D8699C85e595117E",
  zksync:     "0x28731BCC616B5f51dD52CF2e4dF0E78dD1136C06",
  celo:       "0x8B844f885672f333Bc0042cB669255f93a4C1E6b",
  gnosis:     "0x75FC67473A91335B5b8F8821277262a13B38c9b3",
  sonic:      "0x738fD6d10bCc05c230388B4027CAd37f82fe2AF2",
  unichain:   "0xFdf682F51FE81Aa4898F0AE2163d8A55c127fbC7",
  monad:      "0xFdf682F51FE81Aa4898F0AE2163d8A55c127fbC7",
  plasma:     "0x1b35fbA9357fD9bda7ed0429C8BbAbe1e8CC88fc",
  taiko:      "0x346239972d1fa486FC4a521031BC81bFB7D6e8a4",
  sei:        "0xa683c66045ad16abb1bCE5ad46A64d95f9A25785",
  rootstock:  "0x244f68e77357f86a8522323eBF80b5FC2F814d3E",
  filecoin:   "0x83702C6356A1028A900F83d446D189a31646a16b",
  boba:       "0x4BA622997559F9b5Ac68751D7Fc3dEecc23a0e88",
  telos:      "0x738fD6d10bCc05c230388B4027CAd37f82fe2AF2",
  lightlink:  "0x738fD6d10bCc05c230388B4027CAd37f82fe2AF2",
  hemi:       "0x533c7A53389e0538AB6aE1D7798D6C1213eAc28B",
  xdc:        "0x738fD6d10bCc05c230388B4027CAd37f82fe2AF2",
  redbelly:   "0x1b35fbA9357fD9bda7ed0429C8BbAbe1e8CC88fc",
  lens:       "0xAA904d497e42608C014BE83a026E984aFc16129b",
  goat:       "0x738fD6d10bCc05c230388B4027CAd37f82fe2AF2",
  mantle:     "0x447B8E40B0CdA8e55F405C86bC635D02d0540aB8",
  nibiru:     "0xA7E6cB0A6B1BE8b779022A6aFcb097cF0d3Ff4A2",
  etherlink:  "0x9db70E29712Cc8Af10c2B597BaDA6784544FF407",
  bob:        "0x346239972d1fa486FC4a521031BC81bFB7D6e8a4",
  corn:       "0x9db70E29712Cc8Af10c2B597BaDA6784544FF407",
  gensyn:     "0x447B8E40B0CdA8e55F405C86bC635D02d0540aB8",
  robinhood:  "0x8876789976dEcBfCbBbe364623C63652db8C0904",
};

const deployDir = path.join(__dirname, "..", "deployments");
const deployed = new Set(
  fs.readdirSync(deployDir).filter(f => f.endsWith(".json")).map(f => f.replace(".json", ""))
);

for (const [chain, ur] of Object.entries(universalRouters).sort(([a],[b]) => a.localeCompare(b))) {
  const config = NETWORK_CONFIGS[chain];
  if (!config) continue;
  const alreadyHas = config.knownSwapTargets.some(
    (t: any) => t.address.toLowerCase() === ur.toLowerCase()
  );
  const isDeployed = deployed.has(chain);
  const needsWhitelist = isDeployed && !alreadyHas;

  const status = alreadyHas ? "already in config" : "NEEDS ADDING";
  const deployStatus = isDeployed ? (needsWhitelist ? " ** NEEDS ON-CHAIN WHITELIST **" : "") : " (no deployment)";
  console.log(`${chain.padEnd(14)} ${status.padEnd(20)} ${ur}${deployStatus}`);
}
