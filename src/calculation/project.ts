import type { FloorQuantities } from "./quantities";
export function calculateProject(floors: readonly FloorQuantities[]) {
  const sum = (
    key:
      | "floorArea"
      | "ceilingArea"
      | "roomVolume"
      | "contourArea"
      | "grossWallArea",
  ) => floors.reduce((n, f) => n + f[key], 0);
  const availableSum = (
    key: "netWallArea" | "constructionVolume" | "openingArea",
  ) => floors.reduce((n, f) => n + (f[key] ?? 0), 0);
  return {
    complete: floors.every((f) => f.complete),
    floorCount: floors.length,
    roomCount: floors.reduce((n, f) => n + f.roomCount, 0),
    floorArea: sum("floorArea"),
    ceilingArea: sum("ceilingArea"),
    roomVolume: sum("roomVolume"),
    contourArea: sum("contourArea"),
    grossWallArea: sum("grossWallArea"),
    netWallArea: availableSum("netWallArea"),
    constructionVolume: availableSum("constructionVolume"),
    openingArea: availableSum("openingArea"),
  };
}
