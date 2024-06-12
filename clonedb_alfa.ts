const { DynamoDBClient, ListTablesCommand, CreateBackupCommand, DescribeBackupCommand, RestoreTableFromBackupCommand } = require("@aws-sdk/client-dynamodb");
const { STSClient, AssumeRoleCommand } = require("@aws-sdk/client-sts");

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Configurazione degli ambienti
const prodRegion = 'eu-west-1'; // Sostituisci con la tua regione di produzione
const devRegion = 'eu-west-1';  // Sostituisci con la tua regione di sviluppo
const prodPrefix = 'riale-calendar-production-';
const devPrefix = 'riale-calendar-dev-';

// Configurazione del role ARN
const roleArn = 'arn:aws:iam::475192682913:role/OrganizationAccountAccessRole'; // Sostituisci con il tuo role ARN

async function assumeRole(roleArn) {
  const stsClient = new STSClient({});
  const command = new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: 'DynamoDBBackupRestoreSession',
  });
  const data = await stsClient.send(command);
  return {
    accessKeyId: data.Credentials.AccessKeyId,
    secretAccessKey: data.Credentials.SecretAccessKey,
    sessionToken: data.Credentials.SessionToken,
  };
}

async function createDynamoDBClient(region, credentials) {
  return new DynamoDBClient({
    region: region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken
    }
  });
}

async function getTablesWithPrefix(dynamodbClient, prefix) {
  const command = new ListTablesCommand({});
  const data = await dynamodbClient.send(command);
  return data.TableNames.filter(tableName => tableName.startsWith(prefix));
}

async function createBackup(dynamodbClient, tableName) {
  const backupName = `${tableName}-backup`;
  const command = new CreateBackupCommand({
    TableName: tableName,
    BackupName: backupName,
  });
  const data = await dynamodbClient.send(command);
  return data.BackupDetails.BackupArn;
}

async function waitForBackupCompletion(dynamodbClient, backupArn) {
  let backupCompleted = false;
  while (!backupCompleted) {
    const command = new DescribeBackupCommand({
      BackupArn: backupArn,
    });
    const data = await dynamodbClient.send(command);
    if (data.BackupDescription.BackupDetails.BackupStatus === 'AVAILABLE') {
      backupCompleted = true;
    } else {
      await sleep(5000); // Attendi 5 secondi prima di riprovare
    }
  }
}

async function restoreTableFromBackup(dynamodbClient, backupArn, newTableName) {
  const command = new RestoreTableFromBackupCommand({
    TargetTableName: newTableName,
    BackupArn: backupArn,
  });
  const data = await dynamodbClient.send(command);
  return data.TableDescription;
}

async function main() {
  try {
    // Assume Role and get temporary credentials
    const credentials = await assumeRole(roleArn);

    // Create DynamoDB clients with temporary credentials
    const prodDynamoDB = await createDynamoDBClient(prodRegion, credentials);
    const devDynamoDB = await createDynamoDBClient(devRegion, credentials);

    // Step 1: Trova tutte le tabelle di produzione con il prefisso specificato
    const prodTables = await getTablesWithPrefix(prodDynamoDB, prodPrefix);

    // Step 2: Esegui il backup di ogni tabella di produzione e ripristina in sviluppo
    for (const tableName of prodTables) {
      try {
        console.log(`Creazione del backup per la tabella ${tableName}...`);
        const backupArn = await createBackup(prodDynamoDB, tableName);

        console.log(`Attesa del completamento del backup per la tabella ${tableName}...`);
        await waitForBackupCompletion(prodDynamoDB, backupArn);

        const newTableName = tableName.replace(prodPrefix, devPrefix);
        console.log(`Ripristino della tabella ${tableName} come ${newTableName}...`);
        await restoreTableFromBackup(devDynamoDB, backupArn, newTableName);

        console.log(`Tabella ${tableName} ripristinata come ${newTableName} con successo.`);
      } catch (error) {
        console.error(`Errore durante il processo per la tabella ${tableName}:`, error);
      }
    }

    console.log("Processo completato.");
  } catch (error) {
    console.error("Errore durante il processo:", error);
  }
}

main();
