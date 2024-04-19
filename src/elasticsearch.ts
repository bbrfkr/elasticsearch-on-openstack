import { Construct } from 'constructs';
import { TerraformStack } from 'cdktf';
import { getOpenstackProvider } from '../lib';
import { BlockstorageVolumeV3, ComputeInstanceV2, DnsRecordsetV2, DnsZoneV2, LbListenerV2, LbLoadbalancerV2, LbMemberV2, LbMonitorV2, LbPoolV2, NetworkingPortV2 } from '../.gen/providers/openstack';

function getMasterNodeSetting(clusterName: string, currentSeedHosts: string[] = []) {
  return `
# place elasticsearch config file
cat << EOF > /etc/elasticsearch/elasticsearch.yml
cluster.name: ${clusterName}
node.name: $(curl 169.254.169.254/2009-04-04/meta-data/hostname)
path.data: /var/lib/elasticsearch
path.logs: /var/log/elasticsearch
network.host: $(curl 169.254.169.254/2009-04-04/meta-data/local-ipv4)
http.port: 9200
discovery.seed_hosts: [${currentSeedHosts.length == 0 ? "" : currentSeedHosts.join(",")+","}$(curl 169.254.169.254/2009-04-04/meta-data/local-ipv4)]
${currentSeedHosts.length == 0 ? "cluster.initial_master_nodes: [$(curl 169.254.169.254/2009-04-04/meta-data/local-ipv4)]" : ""}
xpack.security.enabled: false
xpack.security.transport.ssl.enabled: false
xpack.security.http.ssl.enabled: false
http.host: 0.0.0.0
node.roles: ["master"]
EOF
chown elasticsearch:elasticsearch /etc/elasticsearch/elasticsearch.yml

# restart elasticsearch
systemctl restart elasticsearch
`;    
}

function getDataNodeSetting(clusterName: string, currentSeedHosts: string[] = []) {
  return `
# place elasticsearch config file
cat << EOF > /etc/elasticsearch/elasticsearch.yml
cluster.name: ${clusterName}
node.name: $(curl 169.254.169.254/2009-04-04/meta-data/hostname)
path.data: /var/lib/elasticsearch
path.logs: /var/log/elasticsearch
network.host: $(curl 169.254.169.254/2009-04-04/meta-data/local-ipv4)
http.port: 9200
discovery.seed_hosts: [${currentSeedHosts.join(",")}]
xpack.security.enabled: false
xpack.security.transport.ssl.enabled: false
xpack.security.http.ssl.enabled: false
http.host: 0.0.0.0
node.roles: [data]
EOF
chown elasticsearch:elasticsearch /etc/elasticsearch/elasticsearch.yml

# restart elasticsearch
systemctl restart elasticsearch
`;    
}

export class ElasticsearchStack extends TerraformStack {
  constructor(scope: Construct, name: string) {
    super(scope, name);

    // define resources here
    getOpenstackProvider(this);

    const serverConfig = scope.node.tryGetContext("serverConfig");
    const masterNodesConfig = serverConfig.masterNodes;
    const dataNodesConfig = serverConfig.dataNodes;
 
    const clusterName = "my-cluster";
    const installElasticsearch = `
export DEBIAN_FRONTEND=noninteractive

# install elasticsearch
wget -qO - https://artifacts.elastic.co/GPG-KEY-elasticsearch | gpg --dearmor -o /usr/share/keyrings/elasticsearch-keyring.gpg
apt-get update && apt-get install -y apt-transport-https
echo "deb [signed-by=/usr/share/keyrings/elasticsearch-keyring.gpg] https://artifacts.elastic.co/packages/8.x/apt stable main" | tee /etc/apt/sources.list.d/elastic-8.x.list
apt-get update && apt-get install -y elasticsearch    
`;
    const osSetting = `
# mount volume
lsblk -f /dev/vdb | grep xfs > /dev/null
if [ $? -ne 0 ] ; then
    mkfs -t xfs /dev/vdb
fi
echo '/dev/vdb /var/lib/elasticsearch xfs defaults 0 0' >> /etc/fstab
mount -a
chown elasticsearch:elasticsearch /var/lib/elasticsearch

# kernel parameter tune
echo vm.max_map_count=262144 > /etc/sysctl.d/90-elasticsearch.conf
sysctl --system
`;


    const masterNodes = [] as ComputeInstanceV2[];

    // master nodes
    for (const index of [...new Array(masterNodesConfig.serverCount).keys()]) {
      const dataVolume = new BlockstorageVolumeV3(this, `MasterVolume${index}`, {
        name: `ElasticsearchMaster${index}`,
        size: 30,
      });
      const port = new NetworkingPortV2(this, `ElasticsearchMasterPort${index}`, {
        networkId: masterNodesConfig.bootNetworkId,
        securityGroupIds: masterNodesConfig.securityGroupIds,
      });
      const currentNode = new ComputeInstanceV2(this, `ElasticsearchMaster${index}`, {
        name: `ElasticsearchMaster${index}`,
        imageId: masterNodesConfig.imageUuid,
        flavorName: masterNodesConfig.flavorName,
        keyPair: masterNodesConfig.keyPairName,
        network: [{port: port.id}],
        userData: `#!/bin/sh
${installElasticsearch}
${osSetting}
${getMasterNodeSetting(clusterName,masterNodes.map(masterNode => masterNode.accessIpV4))}
`,
        blockDevice: [
          {
            uuid: masterNodesConfig.imageUuid,
            sourceType: "image",
            destinationType: "local",
            bootIndex: 0,
            deleteOnTermination: true,
          },
          {
            uuid: dataVolume.id,
            sourceType: "volume",
            destinationType: "volume",
            bootIndex: 1,
            deleteOnTermination: false,
          },
        ],
        dependsOn: masterNodes,
      });
      masterNodes.push(currentNode);
    }

    // data nodes
    for (const index of [...new Array(dataNodesConfig.serverCount).keys()]) {
      const dataVolume = new BlockstorageVolumeV3(this, `DataVolume${index}`, {
        name: `ElasticsearchData${index}`,
        size: 30,
      });
      const port = new NetworkingPortV2(this, `ElasticsearchDataPort${index}`, {
        networkId: dataNodesConfig.bootNetworkId,
        securityGroupIds: dataNodesConfig.securityGroupIds,
      });
      new ComputeInstanceV2(this, `ElasticsearchData${index}`, {
        name: `ElasticsearchData${index}`,
        imageId: dataNodesConfig.imageUuid,
        flavorName: dataNodesConfig.flavorName,
        keyPair: dataNodesConfig.keyPairName,
        network: [{ port: port.id }],
        userData: `#!/bin/sh
${installElasticsearch}
${osSetting}
${getDataNodeSetting(clusterName,masterNodes.map(masterNode => masterNode.accessIpV4))}
`,
        blockDevice: [
          {
            uuid: dataNodesConfig.imageUuid,
            sourceType: "image",
            destinationType: "local",
            bootIndex: 0,
            deleteOnTermination: true,
          },
          {
            uuid: dataVolume.id,
            sourceType: "volume",
            destinationType: "volume",
            bootIndex: 1,
            deleteOnTermination: false,
          },
        ],
        dependsOn: masterNodes,
      });
    }
    const lb = new LbLoadbalancerV2(this, "Lb", {
      loadbalancerProvider: "octavia",
      name: "elasticsearch-master-lb",
      vipNetworkId: masterNodesConfig.bootNetworkId,
    });
    const listener = new LbListenerV2(this, "Listener", {
      loadbalancerId: lb.id,
      protocol: "TCP",
      protocolPort: 80,
    });
    const pool = new LbPoolV2(this, "Pool", {
      listenerId: listener.id,
      lbMethod: "LEAST_CONNECTIONS",
      protocol: "TCP"
    });
    for (const [index, masterNode] of masterNodes.entries()) {
      new LbMemberV2(this, `Master${index}`, {
          address: masterNode.accessIpV4,
          poolId: pool.id,
          protocolPort: 9200,
      });
    }
    new LbMonitorV2(this, "Monitor", {
      delay: 60,
      timeout: 30,
      maxRetries: 3,
      maxRetriesDown: 3,
      poolId: pool.id,
      type: "TCP",
    });
    const zone = new DnsZoneV2(this, "Zone", {
      name: "es.dynamis.bbrfkr.net.",
      email: "bbrfkr@example.com",
      ttl: 600,
    });
    new DnsRecordsetV2(this, "Record", {
      zoneId: zone.id,
      name: `endpoint.${zone.name}`,
      type: "A",
      records: [lb.vipAddress],
      ttl: 600,
    });
  }
}
