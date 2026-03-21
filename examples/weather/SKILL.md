---
name: weather
description: Get weather forecasts and list available cities. Use when the user asks about weather, temperature, or climate conditions in a city.
---

# Weather

A simple weather skill providing forecasts for major cities.

## Key Tools

| Tool | Description |
|---|---|
| `weather__get_forecast` | Get current weather for a city. Params: `city` (string). Returns: `temperature_celsius`, `condition`, `humidity_percent`. |
| `weather__list_cities` | List all cities with available weather data. No params. |

## Example

```
call_tool("weather__list_cities", {})  → [{ name: "paris", country: "France" }, ...]
call_tool("weather__get_forecast", { "city": "paris" })  → { city: "paris", temperature_celsius: 22, condition: "sunny", humidity_percent: 55 }
```
