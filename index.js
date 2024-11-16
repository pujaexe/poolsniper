const { Connection, PublicKey } = require("@solana/web3.js");
const { Metaplex } = require("@metaplex-foundation/js");

const RAYDIUM_PUBLIC_KEY = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const BOT_TOKEN = "7177577713:AAETbhstiJK8bfTKzjl5mhCiIpiP1sGq2VU";
const CHANNELS = [
  "-1002149791590_797", 
  "-1002149791590_799",
];
const zoolanaChannelChatId = "-1002260716985";

const raydium = new PublicKey(RAYDIUM_PUBLIC_KEY);
let connection = new Connection("https://api.mainnet-beta.solana.com", {
  wsEndpoint: "wss://api.mainnet-beta.solana.com",
});
const metaplex = Metaplex.make(connection);

const processedSignatures = new Set();
const SIGNATURE_LIMIT = 10;

async function main(connection, programAddress) {
  console.log("Monitoring logs for program:", programAddress.toString());
  connection.onLogs(programAddress, handleLogs, "finalized");
}

function handleLogs({ logs, err, signature }) {
  if (
    err ||
    !logs?.some((log) => log.includes("initialize2")) ||
    processedSignatures.has(signature)
  )
    return;

  console.log("Signature for 'initialize2':", signature);
  processedSignatures.add(signature);
  fetchRaydiumAccounts(signature, connection);

  if (processedSignatures.size >= SIGNATURE_LIMIT) {
    processedSignatures.clear();
    console.log("Processed signatures cleared to free up memory.");
  }
}

async function fetchRaydiumAccounts(txId, connection, retryCount = 0) {
  try {
    const tx = await connection.getParsedTransaction(txId, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });

    const accounts = tx?.transaction.message.instructions.find(
      (ix) => ix.programId.toBase58() === RAYDIUM_PUBLIC_KEY,
    )?.accounts;
    if (!accounts) return console.log("No accounts found in the transaction.");

    const {
      tokenType,
      tokenPump,
      tokenAAccount,
      tokenBAccount,
      tokenName,
      tokenSymbol,
    } = await determineTokenType(accounts);

    if (tokenType === -1) return console.log("Not Pumpfun token.");

    let contractAddress = tokenPump.toBase58();
    let pairsAddress = accounts[4].toBase58();

    let message = generateMessage(
      contractAddress,
      pairsAddress,
      tokenType === 1,
      tokenName,
      tokenSymbol,
    );

    const messageThreadId = CHANNELS[tokenType].split("_")[1];
    postToTelegramChannel(CHANNELS[tokenType], message, messageThreadId)
      .then((_) => {
        console.log("Posted to Zoolana.Club");
      })
      .catch((err) => {
        console.error(err);
      });

    // For paid only tokens, send notif to Zoolana.Club Channel
    if (tokenType === 1) {
      postToTelegramChannel(zoolanaChannelChatId, message)
        .then((_) => {
          console.log("Posted to Zoolana.Club Channel");
        })
        .catch((err) => {
          console.error(err);
        });
    }
  } catch (error) {
    if (error.message.includes("429 Too Many Requests")) {
      // Eksponensial backoff
      const delay = Math.pow(2, retryCount) * 500; // Delay dalam milidetik
      console.log(
        `Server responded with 429. Retrying after ${delay}ms delay...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));

      // Maksimal retryCount untuk mencegah retry berulang kali
      if (retryCount < 5) {
        return fetchRaydiumAccounts(txId, connection, retryCount + 1);
      } else {
        console.error(
          "Reached maximum retry limit. Skipping this transaction.",
        );
      }
    } else {
      console.error("Error saat mengambil akun:", error);
    }
  }
}

async function determineTokenType(accounts) {
  const [tokenAAccount, tokenBAccount] = [accounts[8], accounts[9]];
  let tokenType = -1;
  let tokenPump = undefined;
  let tokenName = undefined;
  let tokenSymbol = undefined;

  if (tokenAAccount.toBase58().endsWith("pump")) tokenPump = tokenAAccount;
  else if (tokenBAccount.toBase58().endsWith("pump")) tokenPump = tokenBAccount;

  if (tokenPump) {
    const hasDexProfile = await fetchTokenProfile(tokenPump.toBase58());
    tokenType = hasDexProfile ? 1 : 0;

    const metadata = await fetchTokenMetadata(tokenPump.toBase58());
    tokenName = metadata.tokenName;
    tokenSymbol = metadata.tokenSymbol;
  }

  return {
    tokenType,
    tokenPump,
    tokenAAccount,
    tokenBAccount,
    tokenName,
    tokenSymbol,
  };
}

async function fetchTokenProfile(address) {
  try {
    const response = await fetch(
      `https://api.dexscreener.com/orders/v1/solana/${address}`,
    );
    if (!response.ok) {
      console.error(`HTTP error! Status: ${response.status}`);
      return false;
    }
    const data = await response.json();
    return data.some(
      (item) => item.type === "tokenProfile" && item.status === "approved",
    );
  } catch (error) {
    console.error("Error fetching or processing data:", error);
    return false;
  }
}

async function fetchTokenMetadata(address) {
  let tokenName = undefined;
  let tokenSymbol = undefined;

  try {
    const mintAddress = new PublicKey(address);

    const metadataAccount = metaplex
      .nfts()
      .pdas()
      .metadata({ mint: mintAddress });

    const metadataAccountInfo =
      await connection.getAccountInfo(metadataAccount);

    if (metadataAccountInfo) {
      const token = await metaplex
        .nfts()
        .findByMint({ mintAddress: mintAddress });
      tokenName = token.name;
      tokenSymbol = token.symbol;
    }
  } catch (error) {
    console.error("Error fetching or processing data:", error);
  } finally {
    return { tokenName, tokenSymbol };
  }
}

async function postToTelegramChannel(channelId, message, threadId) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  let payload = {
    chat_id: channelId,
    text: message,
    parse_mode: "Markdown",
  };

  if (threadId) {
    payload = {
      ...payload,
      message_thread_id: threadId,
    }
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      //console.log("Message sent successfully:", await response.json());
      console.log("Message sent successfully:");
    } else {
      console.error("Failed to send message:", response.statusText);
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

function generateMessage(ca, pa, dexpStatus, name, symbol) {
  const dexpStatusText = dexpStatus ? "✅ Dexpaid" : undefined;
  return `
*$${symbol} | ${name}*
⚡️ CA: \`${ca}\`
${dexpStatusText ? dexpStatusText : ""}
[DEX](https://dexscreener.com/solana/${pa}) | [Bonk Bot](https://t.me/furiosa_bonkbot?start=ref_tcisj_ca_${ca}) | [Trojan Bot](https://t.me/solana_trojanbot?start=r-pujaexe-${ca})
    `;
}

main(connection, raydium).catch(console.error);
