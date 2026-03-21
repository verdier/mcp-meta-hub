import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Simulated weather data
const CITIES: Record<string, { lat: number; lon: number; country: string }> = {
  paris: { lat: 48.86, lon: 2.35, country: "France" },
  london: { lat: 51.51, lon: -0.13, country: "United Kingdom" },
  tokyo: { lat: 35.68, lon: 139.69, country: "Japan" },
  "new york": { lat: 40.71, lon: -74.01, country: "United States" },
  sydney: { lat: -33.87, lon: 151.21, country: "Australia" },
};

function simulateWeather(city: string) {
  const seed = city.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const temp = Math.round(((seed * 7 + Date.now() / 3600000) % 35) - 5);
  const conditions = ["sunny", "cloudy", "rainy", "partly cloudy", "windy"];
  const condition = conditions[seed % conditions.length];
  const humidity = 30 + (seed % 60);
  return { temperature_celsius: temp, condition, humidity_percent: humidity };
}

const server = new McpServer({
  name: "weather",
  version: "0.1.0",
});

server.tool(
  "get_forecast",
  "Get the current weather forecast for a city.",
  {
    city: z.string().describe("City name (e.g. \"paris\", \"tokyo\")"),
  },
  async ({ city }) => {
    const key = city.toLowerCase().trim();
    const info = CITIES[key];
    if (!info) {
      return {
        content: [{
          type: "text" as const,
          text: `City "${city}" not found. Use list_cities to see available cities.`,
        }],
        isError: true,
      };
    }
    const weather = simulateWeather(key);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ city: key, ...info, ...weather }, null, 2),
      }],
    };
  },
);

server.tool(
  "list_cities",
  "List all cities with available weather data.",
  {},
  async () => {
    const cities = Object.entries(CITIES).map(([name, info]) => ({
      name,
      country: info.country,
    }));
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(cities, null, 2),
      }],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(`[weather] Fatal: ${error}`);
  process.exit(1);
});
