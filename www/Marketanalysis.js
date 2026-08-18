// marketAnalysis.js — Scoring, Technical Indicators, and Explainable Factors
export function calculatePrediction(quote, signals = {}, history = []) {
 let bullishPoints = 0;
 let totalCriteria = 0;
 const bullishFactors = [];
 const bearishFactors = [];

 // Trend Evaluation
 totalCriteria += 3;
 const price = quote.price || 0;
 const sma20 = signals.sma_20 || quote.sma20;
 const sma50 = signals.sma_50 || quote.sma50;
 const sma200 = signals.sma_200 || quote.sma200;

 if (sma20 && price > sma20) {
   bullishPoints += 1;
   bullishFactors.push('Price is trading above the 20-day Simple Moving Average');
 } else if (sma20) {
   bearishFactors.push('Price is trading below the 20-day Simple Moving Average');
 }

 if (sma50 && price > sma50) {
   bullishPoints += 1;
   bullishFactors.push('Price is holding above the 50-day medium-term moving average');
 } else if (sma50) {
   bearishFactors.push('Price is below the 50-day moving average');
 }

 if (sma200 && price > sma200) {
   bullishPoints += 1;
   bullishFactors.push('Long-term market structure is positive (above SMA 200)');
 } else if (sma200) {
   bearishFactors.push('Long-term trend shows weakness (below SMA 200)');
 }

 // Momentum (RSI)
 totalCriteria += 1;
 const rsi = signals.rsi_14 !== undefined ? Number(signals.rsi_14) : 50;
 if (rsi >= 40 && rsi <= 65) {
   bullishPoints += 1;
   bullishFactors.push(`RSI at ${rsi.toFixed(1)} reflects healthy momentum without extreme overbought conditions`);
 } else if (rsi > 70) {
   bearishFactors.push(`RSI at ${rsi.toFixed(1)} indicates overbought conditions susceptible to a pullback`);
 } else if (rsi < 30) {
   bearishFactors.push(`RSI at ${rsi.toFixed(1)} reflects oversold momentum`);
 } else {
   bearishFactors.push(`RSI is neutral at ${rsi.toFixed(1)}`);
 }

 // MACD Crossover
 totalCriteria += 1;
 const macdSignal = signals.macd_above_signal || signals.macd_bullish;
 if (macdSignal) {
   bullishPoints += 1;
   bullishFactors.push('MACD indicates a bullish crossover / positive momentum');
 } else {
   bearishFactors.push('MACD lacks bullish crossover confirmation');
 }

 const score = Math.round((bullishPoints / Math.max(totalCriteria, 1)) * 100);
 const bearishScore = 100 - score;

 let classification = 'Neutral';
 if (score >= 80) classification = 'Strong Bullish';
 else if (score >= 65) classification = 'Bullish';
 else if (score >= 55) classification = 'Slightly Bullish';
 else if (score <= 20) classification = 'Strong Bearish';
 else if (score <= 35) classification = 'Bearish';
 else if (score <= 45) classification = 'Slightly Bearish';

 const confidence = Math.min(88, Math.max(50, Math.round(50 + Math.abs(score - 50) * 0.8)));

 return {
   score,
   bearishScore,
   classification,
   confidence,
   bullishFactors,
   bearishFactors
 };
}